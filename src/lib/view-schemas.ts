import { z } from 'zod';

export const VIEW_URI = 'ui://browserless/view/v2.html';
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

// Replay is the first kind. Add future kinds with their own summary schemas.
export const ShowOutputSchema = z.object({
  viewRef: z.string(),
  kind: z.literal('replay'),
  summary: z.string(),
  expiresAt: z.string().datetime(),
  data: ReplaySummarySchema,
});

export const ViewSourceSchema = z.object({
  viewRef: z.string(),
  bytes: z.number().int().nonnegative().max(VIEW_DATA_MAX_BYTES),
  encoding: z.literal('base64-json'),
});

export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;
export type PreparedView = z.infer<typeof ShowOutputSchema>;
