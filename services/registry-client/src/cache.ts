// TTL cache for registry-supplied disclosed contracts.

export interface CacheEntry<V> {
  value: V;
  fetchedAt: number;
  ttlMs?: number;
}

export class TtlCache<K, V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  constructor(
    private readonly hashKey: (k: K) => string,
    private readonly defaultTtlMs?: number,
  ) {}

  get(k: K): V | undefined {
    const entry = this.entries.get(this.hashKey(k));
    if (!entry) return undefined;
    const ttl = entry.ttlMs ?? this.defaultTtlMs;
    if (ttl !== undefined && Date.now() - entry.fetchedAt > ttl) {
      this.entries.delete(this.hashKey(k));
      return undefined;
    }
    return entry.value;
  }

  set(k: K, v: V, ttlMs?: number): void {
    this.entries.set(this.hashKey(k), {
      value: v,
      fetchedAt: Date.now(),
      ttlMs,
    });
  }

  invalidate(k: K): void {
    this.entries.delete(this.hashKey(k));
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
