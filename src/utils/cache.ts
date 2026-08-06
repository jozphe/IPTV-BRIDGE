/**
 * Lightweight in-memory TTL cache.
 *
 * On Vercel, "warm" serverless instances persist module-level memory between
 * invocations. This lets us reuse parsed M3U playlists, Xtream stream lists and
 * TMDB lookups across requests without any external database, dramatically
 * reducing latency and upstream provider load.
 *
 * It also performs in-flight request de-duplication: if two requests ask for
 * the same key at the same time, only ONE upstream fetch is performed.
 */

interface CacheEntry<T> {
  value: T;
  bytes: number;
  staleAt: number;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const MAX_ENTRIES = 600;
// Serverless instances share module memory across all configured users, so
// bound total footprint by approximate size as well as entry count. Each
// entry can be a multi-thousand-item stream list (several MB), so a pure
// entry cap is not enough to avoid an OOM kill under heavy concurrent use.
const MAX_BYTES = 128 * 1024 * 1024;

let totalBytes = 0;

function approxBytes(value: unknown): number {
  try {
    return (JSON.stringify(value) || '').length * 2; // UTF-16 approx
  } catch {
    return 0;
  }
}

function removeEntry(key: string): void {
  const entry = store.get(key);
  if (entry) {
    totalBytes -= entry.bytes;
    store.delete(key);
  }
}

function evictIfNeeded(): void {
  const now = Date.now();
  // Evict expired entries first.
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) removeEntry(key);
  }
  // Then drop oldest insertion-order entries until under both budgets.
  while (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    removeEntry(oldestKey);
  }
}

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    removeEntry(key);
    return undefined;
  }
  return entry.value;
}

export function getStaleCached<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    removeEntry(key);
    return undefined;
  }
  return entry.value;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  removeEntry(key);
  const bytes = approxBytes(value);
  store.set(key, { value, bytes, staleAt: Date.now() + ttlMs, expiresAt: Date.now() + ttlMs * 2 });
  totalBytes += bytes;
  evictIfNeeded();
}

export async function staleWhileRevalidate<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>
): Promise<T> {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  if (entry && entry.expiresAt > now) {
    if (entry.staleAt <= now && !inflight.has(key)) {
      const refresh = producer()
        .then((value) => { setCached(key, value, ttlMs); return value; })
        .finally(() => inflight.delete(key));
      inflight.set(key, refresh);
      void refresh.catch(() => undefined);
    }
    return entry.value;
  }
  return cached(key, ttlMs, producer);
}

export function cacheStats(): { entries: number; inflight: number; approxMb: number } {
  return { entries: store.size, inflight: inflight.size, approxMb: Math.round(totalBytes / 1024 / 1024) };
}

/**
 * Resolve a value from cache, or run `producer` once and cache the result.
 * Concurrent callers for the same key share a single in-flight promise.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>
): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== undefined) return hit;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await producer();
      setCached(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export const TTL = {
  CATEGORIES: 30 * 60 * 1000, // 30 minutes
  STREAMS: 10 * 60 * 1000, // 10 minutes
  TMDB: 24 * 60 * 60 * 1000, // 24 hours
  PLAYLIST: 15 * 60 * 1000 // 15 minutes
};
