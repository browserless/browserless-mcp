import { z } from 'zod';

export const VIEW_URI = 'ui://browserless/view/v9.html';
export const VIEW_UNAVAILABLE =
  'This view is unavailable. Run the original data tool again to prepare a new view.';
export const VIEW_RESULT_MAX_BYTES = 2 * 1024 * 1024;
export const VIEW_CHUNK_MAX_BYTES = 128 * 1024;
export const VIEW_DATA_MAX_BYTES = 50 * 1024 * 1024;

export const ReplayEventSchema = z
  .object({
    type: z.number().int().nonnegative(),
    timestamp: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    data: z.unknown(),
  })
  .passthrough();

export const ReplayPayloadSchema = z
  .object({
    events: z.array(ReplayEventSchema).min(2),
  })
  .passthrough();

export const ReplaySummarySchema = z.object({
  website: z.string().max(256).optional(),
  duration: z.number().finite().nonnegative(),
  eventCount: z.number().int().nonnegative(),
});

export const HandoffSummarySchema = z.object({
  website: z.string().max(256).optional(),
  sessionId: z.string().max(256),
  instructions: z.string().trim().min(1).max(2000),
});
export const HandoffStateSchema = z.object({
  status: z.enum(['open', 'expired', 'closed']),
  reason: z
    .enum(['timeout', 'closed', 'viewerDisconnected', 'userDone', 'userFailed'])
    .nullable(),
  interactable: z.boolean(),
  viewerCount: z.number().int().nonnegative(),
  expiresAt: z.number().finite().positive(),
});

// Keep an object root for hosts which reject a top-level union at discovery.
export const ShowOutputSchema = z
  .object({
    viewRef: z.string(),
    kind: z.enum(['replay', 'handoff']),
    summary: z.string(),
    expiresAt: z.string().datetime(),
    data: z.union([ReplaySummarySchema, HandoffSummarySchema]),
  })
  .superRefine((value, ctx) => {
    const schema =
      value.kind === 'replay' ? ReplaySummarySchema : HandoffSummarySchema;
    if (!schema.safeParse(value.data).success)
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Summary does not match view kind.',
      });
  });

export const ViewSourceSchema = z.object({
  viewRef: z.string(),
  bytes: z.number().int().nonnegative().max(VIEW_DATA_MAX_BYTES),
  encoding: z.literal('base64-json'),
});

export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;
export type PreparedView = z.infer<typeof ShowOutputSchema>;
