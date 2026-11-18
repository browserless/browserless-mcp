import { z } from 'zod';

export const UsageTimeframeSchema = z.enum(['hour', 'day', 'week']);
const counter = z.number().finite().nonnegative().nullable().default(null);
export const UsageSnapshotSchema = z.object({
  timeframe: UsageTimeframeSchema,
  apiKeyIds: z.array(z.string().max(256)).max(50).optional(),
  fetchedAt: z.string().datetime(),
  currentPeriodEnd: counter,
  units: z
    .object({ used: counter, available: counter, overageFee: counter })
    .nullable(),
  counters: z
    .object({
      successful: counter,
      errored: counter,
      timedout: counter,
      queued: counter,
      rejected: counter,
      maxConcurrent: counter,
      captcha: counter,
      proxy: counter,
    })
    .nullable(),
});

export const ActiveSessionsSnapshotSchema = z.object({
  fetchedAt: z.string().datetime(),
  limit: z.number().int().positive().max(50),
  skip: z.number().int().nonnegative(),
  count: counter,
  sessions: z
    .array(
      z.object({
        browserId: z.string().max(256).nullable().default(null),
        startTime: z.string().max(128).nullable().default(null),
        browserName: z.string().max(256).nullable().default(null),
        type: z.string().max(256).nullable().default(null),
      }),
    )
    .max(50),
});
