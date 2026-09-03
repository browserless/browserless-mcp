import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import type {
  McpConfig,
  StripeLinkCheckoutCartLine,
  StripeLinkCheckoutRequest,
  StripeLinkCheckoutResponse,
} from '../@types/types.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import {
  acquireStripeLinkSessionOperation,
  clearExpiredStripeLinkContinuation,
  getActiveSessionByHandle,
  send,
} from '../lib/agent-client.js';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';

const MAX_CHECKOUT_AMOUNT_MINOR = 5_000;
const CHECKOUT_ID_RE = /^lkco_[A-Za-z0-9_-]{32}$/;
const HANDLE_RE = /^(s:|attach:)[A-Za-z0-9:_-]{3,200}$/;
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

const CreateSchema = z
  .object({
    action: z.literal('create'),
    browser_session_handle: SessionHandleSchema,
    merchant: z
      .object({
        name: z.string().trim().min(1).max(200).describe('Merchant name'),
        url: z.url().describe('Active merchant checkout URL'),
      })
      .strict(),
    amount_minor: z
      .number()
      .int()
      .positive()
      .max(MAX_CHECKOUT_AMOUNT_MINOR)
      .describe('Exact checkout total in integer USD minor units (cents)'),
    currency: z.literal('usd'),
    cart: z.array(CartLineSchema).min(1).max(100),
    selectors: SelectorsSchema,
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
    outcome: z.enum(['success', 'blocked', 'abandoned']),
    tags: z
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
      .max(10)
      .optional(),
    step: z.string().max(500).optional(),
  })
  .strict();

export const StripeLinkCheckoutParamsSchema = z.discriminatedUnion('action', [
  CreateSchema,
  ContinueSchema,
  ReportSchema,
]);

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
  defineTool<StripeLinkCheckoutRequest, StripeLinkCheckoutResponse>(
    server,
    config,
    analytics,
    {
      name: 'browserless_link_checkout',
      description:
        'Create, resume, cancel, or report a Stripe Link checkout in the exact active browser session. ' +
        'Create requires the latest browserless_agent sessionId and payment-field deep selectors. ' +
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
        if (params.action === 'create') validateHttpUrl(params.merchant.url);
      },
      run: async ({ params, token, apiUrl, log }) => {
        if (params.action === 'create') {
          const total = cartTotal(params.cart);
          if (!Number.isSafeInteger(total) || total !== params.amount_minor) {
            throw new UserError(
              'amount_minor must equal the sum of cart line totals.',
            );
          }
        }
        let session;
        try {
          session = getActiveSessionByHandle(
            params.browser_session_handle,
            apiUrl,
            token,
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
          const response = await send(
            session,
            'stripeLinkCheckout',
            command as Record<string, unknown>,
            config.requestTimeout,
          );
          if (response.error) {
            throw new UserError(
              'Stripe Link checkout could not continue safely in this browser session.',
            );
          }
          const result = normalize(response.result);
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
            params.action === 'report' ||
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
        cart_lines: params.action === 'create' ? params.cart.length : undefined,
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
