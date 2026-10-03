import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import type {
  McpConfig,
  StripeLinkCheckoutCartLine,
  StripeLinkCheckoutResponse,
} from '../@types/types.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import {
  acquireStripeLinkSessionOperation,
  clearExpiredStripeLinkContinuation,
  getActiveSessionByHandle,
  send,
} from '../lib/agent-client.js';
import { defineTool, assertHttpScheme } from '../lib/define-tool.js';

const MAX_CHECKOUT_AMOUNT_MINOR = 5_000;
const OUTCOME_REPORT_TTL_MS = 15 * 60 * 1_000;
const CHECKOUT_ID_RE = /^lkco_[A-Za-z0-9_-]{32}$/;
const HANDLE_RE = /^(s:|attach:)[A-Za-z0-9:_-]{3,200}$/;
// Exact coordinator-owned validation messages only. Raw provider/frame errors
// may contain payment credentials, so never forward arbitrary backend text.
const CHECKOUT_VALIDATION_ERRORS = new Set([
  'selectors are required',
  'selectors require either expiry or both exp_month and exp_year',
  'selectors must identify distinct fields',
  'Payment field selector was not found',
  'merchant.url must match the active checkout origin',
  'Payment field is outside the merchant or Stripe origin',
  ...[
    'number',
    'cvc',
    'expiry',
    'exp_month',
    'exp_year',
    'postal',
    'cardholder_name',
    'line1',
    'line2',
    'city',
  ].map((field) => `selectors.${field} is invalid`),
]);
// Coordinator-owned checkout-input validation messages. They describe the
// caller's own merchant/cart/amount payload, carry no session or credential
// detail, and are actionable, so forward them verbatim. Patterns because cart
// messages carry a line index and the amount messages carry the configured
// bound.
const CHECKOUT_VALIDATION_ERROR_PATTERNS: RegExp[] = [
  /^Checkout body must be an object$/,
  /^merchant is required$/,
  /^merchant\.name is invalid$/,
  /^merchant\.url is invalid$/,
  /^merchant\.url must be an absolute HTTP\(S\) URL$/,
  /^currency must be usd$/,
  /^amount_minor must be an integer between \d+ and \d+$/,
  /^amount_minor must equal the sum of cart quantity \* unit_amount_minor$/,
  /^cart must contain between 1 and 100 lines$/,
  /^cart\[\d+\] must be an object$/,
  /^cart\[\d+\]\.name is invalid$/,
  /^cart\[\d+\]\.quantity must be an integer between \d+ and \d+$/,
  /^cart\[\d+\]\.unit_amount_minor must be an integer between \d+ and \d+$/,
];
const isPassThroughCheckoutError = (message: string): boolean =>
  CHECKOUT_VALIDATION_ERRORS.has(message) ||
  CHECKOUT_VALIDATION_ERROR_PATTERNS.some(
    (pattern) => pattern.exec(message)?.[0] === message,
  );
const STATUSES = new Set([
  'created',
  'pending_approval',
  'requires_action',
  'approved',
  'filled',
  'denied',
  'expired',
  'failed',
  'canceled',
  'succeeded',
  'submitted',
  'blocked',
  'abandoned',
]);
const RESUMABLE_STATUSES = new Set([
  'created',
  'pending_approval',
  'requires_action',
  'approved',
]);
const TERMINAL_STATUSES = new Set([
  'denied',
  'expired',
  'failed',
  'canceled',
  'succeeded',
  'submitted',
  'blocked',
  'abandoned',
]);
const STRIPE_LINK_HOSTS = (host: string): boolean =>
  host === 'link.com' ||
  host.endsWith('.link.com') ||
  host === 'stripe.com' ||
  host.endsWith('.stripe.com');
const ACTION_TYPES = new Set([
  'verify_identity',
  'verify_address',
  'verify_phone',
  'verify_email',
  'ssn_verification',
  'identity_verification',
  'contact_support',
  'select_payment_method',
  'add_payment_method',
  'update_payment_method',
  're_authorize',
  'three_d_secure',
  'three_d_secure_retry',
]);
const ACTION_RESOLUTIONS = new Set([
  'auto_resume',
  'create_new_spend_request',
  'create_new_spend_request_after_completion',
]);

const SessionHandleSchema = z
  .string()
  .regex(HANDLE_RE)
  .describe(
    'Opaque sessionId returned by the browserless_agent call that has the active checkout page',
  );
const CheckoutIdSchema = z
  .string()
  .regex(CHECKOUT_ID_RE)
  .describe('Opaque checkout_id returned by the create action');
const SelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .describe('Deep selector copied from the active checkout snapshot');

const CartLineSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe('Cart line name'),
    quantity: z.number().int().positive().max(100).describe('Item quantity'),
    unit_amount_minor: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CHECKOUT_AMOUNT_MINOR)
      .describe('Unit price in integer USD minor units (cents)'),
  })
  .strict();

const cartTotal = (cart: StripeLinkCheckoutCartLine[]): number =>
  cart.reduce(
    (total, line) => total + line.quantity * line.unit_amount_minor,
    0,
  );

const SelectorsSchema = z
  .object({
    number: SelectorSchema.describe('Card number input deep selector'),
    cvc: SelectorSchema.describe('CVC input deep selector'),
    expiry: SelectorSchema.optional().describe(
      'Combined MM/YY expiry input deep selector',
    ),
    exp_month: SelectorSchema.optional().describe(
      'Split expiry month input deep selector',
    ),
    exp_year: SelectorSchema.optional().describe(
      'Split expiry year input deep selector',
    ),
    postal: SelectorSchema.optional().describe(
      'Billing postal code input deep selector',
    ),
    cardholder_name: SelectorSchema.optional().describe(
      'Cardholder name input deep selector',
    ),
    line1: SelectorSchema.optional().describe(
      'Billing address line 1 input deep selector',
    ),
    line2: SelectorSchema.optional().describe(
      'Billing address line 2 input deep selector',
    ),
    city: SelectorSchema.optional().describe(
      'Billing city/locality input deep selector',
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const combined = Boolean(value.expiry);
    const split = Boolean(value.exp_month && value.exp_year);
    if (
      combined === split ||
      Boolean(value.exp_month) !== Boolean(value.exp_year)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiry'],
        message: 'provide either expiry or both exp_month and exp_year',
      });
    }
    const selectors = Object.values(value).filter(
      (item): item is string => typeof item === 'string',
    );
    if (new Set(selectors).size !== selectors.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'each payment field selector must be distinct',
      });
    }
  });

const MerchantSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe('Merchant name'),
    url: z.url().describe('Active merchant checkout URL'),
  })
  .strict();

const AmountMinorSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_CHECKOUT_AMOUNT_MINOR)
  .describe('Exact checkout total in integer USD minor units (cents)');

const CartSchema = z.array(CartLineSchema).min(1).max(100);

const OutcomeSchema = z.enum(['success', 'blocked', 'abandoned']);

const TagsSchema = z
  .array(
    z.enum([
      'stripe_checkout',
      'captcha',
      'anti_bot_script',
      'cdn_block',
      'waf_block',
      'dns_block',
      'rate_limited',
      'login_required',
      '3ds_challenge',
      'page_inaccessible',
      'timeout',
      'site_error',
      'payment_declined',
      'other',
    ]),
  )
  .max(10);

const StepSchema = z.string().max(500);

const CreateSchema = z
  .object({
    action: z.literal('create'),
    browser_session_handle: SessionHandleSchema,
    merchant: MerchantSchema,
    amount_minor: AmountMinorSchema,
    currency: z.literal('usd'),
    cart: CartSchema,
    selectors: SelectorsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = cartTotal(value.cart);
    if (!Number.isSafeInteger(total) || total !== value.amount_minor) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount_minor'],
        message: 'amount_minor must equal the sum of cart line totals',
      });
    }
  });

const ContinueSchema = z
  .object({
    action: z.enum(['resume', 'cancel']),
    browser_session_handle: SessionHandleSchema,
    checkout_id: CheckoutIdSchema,
  })
  .strict();

const ReportSchema = z
  .object({
    action: z.literal('report'),
    browser_session_handle: SessionHandleSchema,
    checkout_id: CheckoutIdSchema,
    outcome: OutcomeSchema,
    tags: TagsSchema.optional(),
    step: StepSchema.optional(),
  })
  .strict();

// Runtime validation + per-action type narrowing. NOT the advertised tool
// schema: a discriminatedUnion serializes to a root-level JSON-Schema `oneOf`,
// which OpenAI's hosted-MCP importer rejects with 424 (Failed Dependency) —
// breaking every hosted-agent flow that imports the full surface. The tool
// advertises the flat StripeLinkCheckoutParamsSchema below and re-parses
// through this union in run() to recover the narrowed type.
export const CheckoutInputSchema = z.discriminatedUnion('action', [
  CreateSchema,
  ContinueSchema,
  ReportSchema,
]);

// Advertised tool schema: a flat object (no oneOf/anyOf) so OpenAI's
// hosted-MCP importer accepts it. Field types are validated here; the
// per-action required-field combinations are enforced at runtime by
// CheckoutInputSchema (re-parsed in run()).
export const StripeLinkCheckoutParamsSchema = z
  .object({
    action: z
      .enum(['create', 'resume', 'cancel', 'report'])
      .describe('Checkout step to run.'),
    browser_session_handle: SessionHandleSchema,
    merchant: MerchantSchema.optional().describe('Required for create.'),
    amount_minor: AmountMinorSchema.optional().describe('Required for create.'),
    currency: z
      .literal('usd')
      .optional()
      .describe(
        'Required for create; must be "usd". The Link card is billed in USD, so switch a geo-localized checkout (e.g. RSD/EUR) to USD with its currency selector before creating when the option exists — a non-USD charge may be declined for currency mismatch. If no USD option is available, stop and tell the user rather than proceeding: a non-USD price cannot form a correct USD amount, so never pass a foreign-currency amount as USD cents.',
      ),
    cart: CartSchema.optional().describe('Required for create.'),
    selectors: SelectorsSchema.optional().describe(
      'Required whenever a card form is shown, including Stripe-hosted checkout — its Link CLI one-time-card variant shows an AI-agent steering checkbox yet still renders a card form. Omit only for a pure Link Pay Token handoff: a link_pay_token input with no card form.',
    ),
    checkout_id: CheckoutIdSchema.optional().describe(
      'Required for resume, cancel, and report.',
    ),
    outcome: OutcomeSchema.optional().describe('Required for report.'),
    tags: TagsSchema.optional().describe('Optional for report.'),
    step: StepSchema.optional().describe('Optional for report.'),
  })
  .strict()
  .describe(
    'Stripe Link checkout in the active browser session. Required fields ' +
      'depend on `action`: create needs merchant, amount_minor, currency, ' +
      'cart (and selectors whenever a card form is shown); resume and cancel need checkout_id; report needs ' +
      'checkout_id and outcome. The Link card is billed in USD — switch the checkout to USD before create when the option exists.',
  );

type StripeLinkCheckoutParams = z.infer<typeof StripeLinkCheckoutParamsSchema>;

const approvalUrl = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Browserless returned an invalid checkout approval URL');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    !STRIPE_LINK_HOSTS(url.hostname)
  ) {
    throw new Error('Browserless returned an untrusted checkout approval URL');
  }
  return url.toString();
};

const normalize = (value: unknown): StripeLinkCheckoutResponse => {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Browserless returned an invalid checkout response');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
    throw new Error('Browserless returned an invalid checkout status');
  }
  const result: StripeLinkCheckoutResponse = { status: body.status };
  const url = approvalUrl(body.approval_url);
  if (url) result.approval_url = url;
  const actionUrl = approvalUrl(body.action_url);
  if (actionUrl) result.action_url = actionUrl;
  if (body.action_type !== undefined) {
    if (
      typeof body.action_type !== 'string' ||
      !ACTION_TYPES.has(body.action_type)
    ) {
      throw new Error('Browserless returned an invalid checkout action');
    }
    result.action_type = body.action_type;
  }
  if (body.action_resolution !== undefined) {
    if (
      typeof body.action_resolution !== 'string' ||
      !ACTION_RESOLUTIONS.has(body.action_resolution)
    ) {
      throw new Error('Browserless returned an invalid checkout action');
    }
    result.action_resolution = body.action_resolution as NonNullable<
      StripeLinkCheckoutResponse['action_resolution']
    >;
  }
  if (body.action_message !== undefined) {
    if (
      typeof body.action_message !== 'string' ||
      !body.action_message.trim() ||
      body.action_message.length > 500 ||
      /(?:\blsrq_|\blink-cli\b|\bspend-request\b|`)/i.test(body.action_message)
    ) {
      throw new Error('Browserless returned an invalid checkout action');
    }
    result.action_message = body.action_message;
  }
  if (
    body.status === 'requires_action' &&
    (!result.action_type || !result.action_resolution || !result.action_message)
  ) {
    throw new Error('Browserless returned an incomplete checkout action');
  }
  if (
    typeof body.instruction === 'string' &&
    body.instruction.length > 0 &&
    body.instruction.length <= 1_000 &&
    !/(?:\blsrq_|\blink-cli\b|\bspend-request\b|`)/i.test(body.instruction)
  ) {
    result.instruction = body.instruction;
  }
  if (typeof body.checkout_id === 'string') {
    if (!CHECKOUT_ID_RE.test(body.checkout_id)) {
      throw new Error('Browserless returned an invalid checkout ID');
    }
    result.checkout_id = body.checkout_id;
  }
  if (body._next !== undefined) {
    if (
      !body._next ||
      Array.isArray(body._next) ||
      typeof body._next !== 'object'
    ) {
      throw new Error('Browserless returned an invalid checkout next step');
    }
    const next = body._next as Record<string, unknown>;
    const validUntil =
      typeof next.valid_until === 'string'
        ? Date.parse(next.valid_until)
        : Number.NaN;
    if (
      !RESUMABLE_STATUSES.has(result.status) ||
      next.action !== 'resume' ||
      typeof next.checkout_id !== 'string' ||
      !CHECKOUT_ID_RE.test(next.checkout_id) ||
      typeof next.valid_until !== 'string' ||
      !Number.isFinite(validUntil) ||
      validUntil <= Date.now() ||
      (result.checkout_id && next.checkout_id !== result.checkout_id)
    ) {
      throw new Error('Browserless returned an invalid checkout next step');
    }
    result._next = {
      action: 'resume',
      checkout_id: next.checkout_id,
      valid_until: next.valid_until,
    };
  }
  // An `auto_resume` action must carry a resume continuation. Without `_next`
  // the caller treats the result as terminal and drops the checkout custody,
  // stranding a checkout the skill forbids replacing. Reject the malformed
  // response instead.
  if (
    result.status === 'requires_action' &&
    result.action_resolution === 'auto_resume' &&
    !result._next
  ) {
    throw new Error('Browserless returned an incomplete checkout next step');
  }
  if (typeof body.last4 === 'string' && /^\d{4}$/.test(body.last4)) {
    result.last4 = body.last4;
  }
  return result;
};

export function registerStripeLinkCheckoutTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<StripeLinkCheckoutParams, StripeLinkCheckoutResponse>(
    server,
    config,
    analytics,
    {
      name: 'browserless_link_checkout',
      description:
        'Create, resume, cancel, or report a Stripe Link checkout in the exact active browser session. ' +
        'Create requires the latest browserless_agent sessionId. Pass payment-field deep selectors whenever a card form is shown, including Stripe-hosted checkout; omit them only for a pure Link Pay Token handoff. ' +
        'Resume retrieves and fills only after Link approval; payment credentials never reach this tool.',
      parameters: StripeLinkCheckoutParamsSchema,
      annotations: {
        title: 'Browserless Stripe Link Checkout',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      validateUrl: (params) => {
        if (params.action === 'create' && params.merchant) {
          assertHttpScheme(params.merchant.url);
        }
      },
      run: async ({ params: rawParams, token, apiUrl, log, userId }) => {
        const parsed = CheckoutInputSchema.safeParse(rawParams);
        if (!parsed.success) {
          throw new UserError(
            parsed.error.issues[0]?.message ??
              'Invalid Stripe Link checkout request.',
          );
        }
        const params = parsed.data;
        let session;
        try {
          session = getActiveSessionByHandle(
            params.browser_session_handle,
            apiUrl,
            token,
            userId,
          );
        } catch {
          throw new UserError(
            'That browser session is not open. Resume it with browserless_agent and use the returned sessionId.',
          );
        }
        const release = await acquireStripeLinkSessionOperation(session);
        try {
          let continuation = session.stripeLinkContinuation;
          const expired =
            params.action !== 'cancel' &&
            clearExpiredStripeLinkContinuation(session);
          if (expired) {
            continuation = undefined;
            if (params.action !== 'create') {
              throw new UserError(
                'The active Stripe Link checkout has expired. Create a new checkout.',
              );
            }
          }
          if (params.action === 'create' && continuation) {
            throw new UserError(
              continuation.allowedNextAction === 'resume'
                ? 'A Stripe Link checkout is already active in this browser. Resume or cancel it before creating another checkout.'
                : 'A Stripe Link checkout is already active in this browser. Report its outcome before creating another checkout.',
            );
          }
          if (params.action !== 'create') {
            if (!continuation) {
              throw new UserError(
                'There is no active Stripe Link checkout in this browser session.',
              );
            }
            if (params.checkout_id !== continuation.checkoutId) {
              throw new UserError(
                'checkout_id does not match the active Stripe Link checkout.',
              );
            }
            const actionAllowed =
              (params.action === 'resume' &&
                continuation.allowedNextAction === 'resume') ||
              (params.action === 'cancel' &&
                continuation.allowedNextAction === 'resume') ||
              (params.action === 'report' &&
                continuation.allowedNextAction === 'report');
            if (!actionAllowed) {
              throw new UserError(
                `The active Stripe Link checkout must ${continuation.allowedNextAction} next.`,
              );
            }
          }
          const { browser_session_handle: _handle, ...command } = params;
          let response;
          try {
            response = await send(
              session,
              'stripeLinkCheckout',
              command as Record<string, unknown>,
              config.requestTimeout,
            );
          } catch (error) {
            if (params.action !== 'create') throw error;
            throw new UserError(
              'Stripe Link checkout creation did not return a confirmed result. Close this browser session before retrying so any pending checkout is canceled safely.',
            );
          }
          if (response.error) {
            throw new UserError(
              isPassThroughCheckoutError(response.error.message)
                ? response.error.message
                : 'Stripe Link checkout could not continue safely in this browser session.',
            );
          }
          const result = normalize(response.result);
          if (
            params.action === 'report' &&
            result.status !== 'requires_action' &&
            RESUMABLE_STATUSES.has(result.status) &&
            !result._next
          ) {
            throw new Error(
              'Browserless returned an incomplete checkout next step',
            );
          }
          if (
            params.action !== 'create' &&
            result._next?.checkout_id !== undefined &&
            result._next.checkout_id !== params.checkout_id
          ) {
            throw new Error(
              'Browserless returned an invalid checkout next step',
            );
          }
          const continuationCheckoutId =
            'checkout_id' in params ? params.checkout_id : undefined;
          const sameContinuation =
            continuationCheckoutId !== undefined &&
            session.stripeLinkContinuation?.checkoutId ===
              continuationCheckoutId;
          const terminal =
            params.action === 'cancel' ||
            TERMINAL_STATUSES.has(result.status) ||
            (result.status === 'requires_action' && !result._next);
          if (sameContinuation && terminal) {
            session.stripeLinkContinuation = undefined;
          } else if (
            result._next?.action === 'resume' &&
            RESUMABLE_STATUSES.has(result.status)
          ) {
            session.stripeLinkContinuation = {
              checkoutId: result._next.checkout_id,
              allowedNextAction: 'resume',
              validUntil: Date.parse(result._next.valid_until),
            };
          } else if (
            params.action === 'resume' &&
            result.status === 'filled' &&
            result.checkout_id === params.checkout_id
          ) {
            session.stripeLinkContinuation = {
              checkoutId: params.checkout_id,
              allowedNextAction: 'report',
              validUntil: Date.now() + OUTCOME_REPORT_TTL_MS,
            };
          }
          if (params.action === 'create') {
            session.skillState.fired.set(
              'agentic-checkout',
              session.skillState.cmdIndex,
            );
          }
          if (terminal) {
            session.skillState.fired.delete('agentic-checkout');
          }
          log.debug(
            `Stripe Link checkout: action=${params.action} status=${result.status}`,
          );
          return result;
        } finally {
          release();
        }
      },
      analyticsProps: (params, result) => ({
        action: params.action,
        status: result.status,
        amount_minor:
          params.action === 'create' ? params.amount_minor : undefined,
        cart_lines:
          params.action === 'create' ? params.cart?.length : undefined,
      }),
      format: (result) => [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    },
  );
}
