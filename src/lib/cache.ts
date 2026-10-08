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
  }

  // Start the sweep timer lazily, on the first write: a cache that is never
  // written (the api-client's per-call fallback) then holds no timer to leak.
  private ensureTimer(): void {
    if (this.ttlMs > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.ttlMs * 2);
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

  set<T>(key: string, value: T, ttlMs: number = this.ttlMs): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    this.ensureTimer();
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
