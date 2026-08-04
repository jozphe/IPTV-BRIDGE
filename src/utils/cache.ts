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
  staleAt: number;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const MAX_ENTRIES = 200;

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  // Evict oldest / expired entries first.
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // If still over capacity, drop oldest insertion-order entries.
  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function getStaleCached<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, staleAt: Date.now() + ttlMs, expiresAt: Date.now() + ttlMs * 2 });
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

export function cacheStats(): { entries: number; inflight: number } {
  return { entries: store.size, inflight: inflight.size };
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
