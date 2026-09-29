import type { Redis } from 'ioredis';

const WINDOW_MS = 3_600_000;
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 3600) end
return {count, redis.call('TTL', KEYS[1])}
`;

export function createRegisterRateLimiter(opts: {
  redis?: Redis;
  limitPerHour: number;
  now?: () => number;
}) {
  const entries = new Map<string, { windowStart: number; count: number }>();
  return {
    async hit(
      ip: string,
    ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
      const now = (opts.now ?? Date.now)();
      const window = Math.floor(now / WINDOW_MS);
      const windowStart = window * WINDOW_MS;
      const remaining = Math.max(
        1,
        Math.ceil((windowStart + WINDOW_MS - now) / 1000),
      );
      let count: number;
      let retryAfterSeconds = remaining;
      if (opts.redis) {
        const result = (await opts.redis.eval(
          HIT_SCRIPT,
          1,
          `mcp:dcr-rl:${ip}:${window}`,
        )) as [number, number];
        count = result[0];
        // The key expires an hour after its first hit, but its quota resets
        // at the clock-hour boundary, which can be sooner than its TTL.
        retryAfterSeconds = Math.max(1, Math.min(remaining, result[1]));
      } else {
        for (const [key, entry] of entries) {
          if (entry.windowStart !== windowStart) entries.delete(key);
        }
        const entry = entries.get(ip) ?? { windowStart, count: 0 };
        count = ++entry.count;
        entries.set(ip, entry);
      }
      return { allowed: count <= opts.limitPerHour, retryAfterSeconds };
    },
  };
}
