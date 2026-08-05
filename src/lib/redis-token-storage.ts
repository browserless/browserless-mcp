import { Redis } from 'ioredis';
import type { TokenStorage } from 'fastmcp/auth';

const KEY_PREFIX = 'mcp:oauth:';

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

export class RedisTokenStorage implements TokenStorage {
  constructor(private redis: Redis) {}

  private key(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }

  async get(key: string): Promise<null | unknown> {
    const json = await this.redis.get(this.key(key));
    return json ? (JSON.parse(json) as unknown) : null;
  }

  async save(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.redis.set(
      this.key(key),
      JSON.stringify(value),
      'EX',
      ttl ?? DEFAULT_TTL_SECONDS,
    );
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  async take(key: string): Promise<null | unknown> {
    const json = await this.redis.getdel(this.key(key));
    return json ? (JSON.parse(json) as unknown) : null;
  }

  // Redis expires keys via TTL; there is nothing to sweep.
  async cleanup(): Promise<void> {}
}
