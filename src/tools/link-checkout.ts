import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  McpConfig,
  StripeLinkCheckoutRequest,
  StripeLinkCheckoutResponse,
} from '../@types/types.js';

const MAX_CHECKOUT_AMOUNT_MINOR = 5_000;

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

export const StripeLinkCheckoutParamsSchema = z
  .object({
    merchant: z
      .object({
        name: z.string().trim().min(1).max(200).describe('Merchant name'),
        url: z.url().describe('Merchant checkout URL (http or https)'),
      })
      .strict(),
    amount_minor: z
      .number()
      .int()
      .positive()
      .max(MAX_CHECKOUT_AMOUNT_MINOR)
      .describe('Exact checkout total in integer USD minor units (cents)'),
    currency: z
      .literal('usd')
      .describe('Checkout currency; only lowercase "usd" is supported'),
    cart: z
      .array(CartLineSchema)
      .min(1)
      .max(100)
      .describe('Checkout cart lines'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const cartTotal = value.cart.reduce(
      (total, line) => total + line.quantity * line.unit_amount_minor,
      0,
    );
    if (!Number.isSafeInteger(cartTotal) || cartTotal !== value.amount_minor) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount_minor'],
        message: 'amount_minor must equal the sum of cart line totals',
      });
    }
  });

const cartTotal = (params: StripeLinkCheckoutRequest): number =>
  params.cart.reduce(
    (total, line) => total + line.quantity * line.unit_amount_minor,
    0,
  );

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
        'Request an agentic checkout with the connected Stripe Link wallet. ' +
        'Use only after the authenticated merchant flow reaches payment. ' +
        'Amounts are exact integer USD minor units and must match the cart. ' +
        'If approval_url is returned, ask the user to approve there and do not ' +
        'claim the purchase completed until a later checkout response confirms it.',
      parameters: StripeLinkCheckoutParamsSchema,
      annotations: {
        title: 'Browserless Stripe Link Checkout',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      validateUrl: (params) => validateHttpUrl(params.merchant.url),
      run: async ({ client, params, log }) => {
        // Defense in depth if a future registration bypasses the Zod refinement.
        if (cartTotal(params) !== params.amount_minor) {
          throw new UserError(
            'amount_minor must equal the sum of cart line totals.',
          );
        }
        const response = await client.stripeLinkCheckout(params);
        log.debug(`Stripe Link checkout: status=${response.status}`);
        return response;
      },
      analyticsProps: (params, result) => ({
        status: result.status,
        amount_minor: params.amount_minor,
        cart_lines: params.cart.length,
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
