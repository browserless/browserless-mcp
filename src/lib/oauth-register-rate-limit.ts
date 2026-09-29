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
  const entries = new Map<string, number>();
  let activeWindow: number | undefined;
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
        if (activeWindow !== window) {
          entries.clear();
          activeWindow = window;
        }
        count = (entries.get(ip) ?? 0) + 1;
        entries.set(ip, count);
      }
      return { allowed: count <= opts.limitPerHour, retryAfterSeconds };
    },
  };
}
