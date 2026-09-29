import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createRegisterRateLimiter } from '../../src/lib/oauth-register-rate-limit.js';

for (const mode of ['memory', 'redis'] as const) {
  (mode === 'redis' && !process.env.REDIS_URL ? describe.skip : describe)(
    `OAuth registration limiter (${mode})`,
    () => {
      it('isolates addresses, counts concurrent hits and resets at the hour boundary', async () => {
        const redis =
          mode === 'redis' ? new Redis(process.env.REDIS_URL!) : undefined;
        const ip = `test-${randomUUID()}`;
        let now = 3_599_001;
        const limiter = createRegisterRateLimiter({
          redis,
          limitPerHour: 3,
          now: () => now,
        });
        try {
          const hits = await Promise.all(
            Array.from({ length: 4 }, () => limiter.hit(ip)),
          );
          expect(hits.map((hit) => hit.allowed)).to.deep.equal([
            true,
            true,
            true,
            false,
          ]);
          expect(hits[3].retryAfterSeconds).to.equal(1);
          expect((await limiter.hit(`${ip}-other`)).allowed).to.equal(true);
          if (redis) {
            const ttl = await redis.ttl(`mcp:dcr-rl:${ip}:0`);
            expect(ttl).to.be.within(1, 3600);
            // A second instance must share the same quota.
            expect(
              (
                await createRegisterRateLimiter({
                  redis,
                  limitPerHour: 3,
                  now: () => now,
                }).hit(ip)
              ).allowed,
            ).to.equal(false);
          }
          now = 3_600_000;
          expect(await limiter.hit(ip)).to.deep.equal({
            allowed: true,
            retryAfterSeconds: 3600,
          });
        } finally {
          if (redis) {
            await redis.del(
              `mcp:dcr-rl:${ip}:0`,
              `mcp:dcr-rl:${ip}:1`,
              `mcp:dcr-rl:${ip}-other:0`,
            );
            await redis.quit();
          }
        }
      });
    },
  );
}
