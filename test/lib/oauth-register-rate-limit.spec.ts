import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createRegisterRateLimiter } from '../../src/lib/oauth-register-rate-limit.js';
import { getConfig } from '../../src/config.js';

describe('OAuth registration quota configuration', () => {
  it('defaults to 300 and rejects invalid quotas explicitly', () => {
    const previous = process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR;
    try {
      delete process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR;
      expect(getConfig().oauthRegisterRateLimitPerHour).to.equal(300);
      process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR = '42';
      expect(getConfig().oauthRegisterRateLimitPerHour).to.equal(42);
      for (const value of [
        '',
        'unlimited',
        '0',
        '-1',
        '1.5',
        '2oops',
        'Infinity',
        '9007199254740992',
      ]) {
        process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR = value;
        expect(() => getConfig(), value).to.throw(
          'OAUTH_REGISTER_RATE_LIMIT_PER_HOUR must be a positive safe integer',
        );
      }
    } finally {
      if (previous === undefined)
        delete process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR;
      else process.env.OAUTH_REGISTER_RATE_LIMIT_PER_HOUR = previous;
    }
  });

  it('resets every memory counter when the clock hour changes in either direction', async () => {
    let now = 7_199_999;
    const limiter = createRegisterRateLimiter({
      limitPerHour: 1,
      now: () => now,
    });
    for (const time of [7_199_999, 7_200_000, 0]) {
      now = time;
      for (const ip of ['1.2.3.4', '5.6.7.8']) {
        expect((await limiter.hit(ip)).allowed).to.equal(true);
        expect((await limiter.hit(ip)).allowed).to.equal(false);
      }
    }
  });
});

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
