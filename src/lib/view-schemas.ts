import { z } from 'zod';

export const VIEW_URI = 'ui://browserless/view/v3.html';
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

export const MediaSummarySchema = z.object({
  website: z.string().max(256).optional(),
  imageCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
});

// Keep an object root for hosts which reject a top-level union at discovery.
export const ShowOutputSchema = z
  .object({
    viewRef: z.string(),
    kind: z.enum(['replay', 'agent-media']),
    summary: z.string(),
    expiresAt: z.string().datetime(),
    data: z.union([ReplaySummarySchema, MediaSummarySchema]),
  })
  .superRefine((value, ctx) => {
    const schema =
      value.kind === 'replay' ? ReplaySummarySchema : MediaSummarySchema;
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

export const MediaPayloadSchema = z.object({
  mediaOrigin: z.string().url(),
  artifacts: z
    .array(
      z
        .object({
          id: z.string().max(128),
          type: z.enum(['image', 'video']),
          mimeType: z.enum([
            'image/png',
            'image/jpeg',
            'image/webp',
            'video/webm',
          ]),
          bytes: z.number().int().positive().max(VIEW_DATA_MAX_BYTES),
          label: z.string().max(128),
          rationale: z.string().max(500),
          commandIndex: z.number().int().positive(),
          website: z.string().max(256).optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          previewUrl: z.string().url().max(2048),
          saveUrl: z.string().url().max(2048),
        })
        .superRefine((asset, ctx) => {
          if ((asset.type === 'video') !== (asset.mimeType === 'video/webm'))
            ctx.addIssue({ code: 'custom', message: 'Mismatched media type.' });
        }),
    )
    .min(1)
    .max(12),
});
