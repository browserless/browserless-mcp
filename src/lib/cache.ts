interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ResponseCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;

    if (ttlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), ttlMs * 2);
      this.sweepTimer.unref();
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
