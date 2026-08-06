"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTL = void 0;
exports.getCached = getCached;
exports.getStaleCached = getStaleCached;
exports.setCached = setCached;
exports.staleWhileRevalidate = staleWhileRevalidate;
exports.cacheStats = cacheStats;
exports.cached = cached;
const store = new Map();
const inflight = new Map();
const MAX_ENTRIES = 200;
function evictIfNeeded() {
    if (store.size <= MAX_ENTRIES)
        return;
    // Evict oldest / expired entries first.
    const now = Date.now();
    for (const [key, entry] of store) {
        if (entry.expiresAt <= now)
            store.delete(key);
    }
    // If still over capacity, drop oldest insertion-order entries.
    while (store.size > MAX_ENTRIES) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined)
            break;
        store.delete(oldestKey);
    }
}
function getCached(key) {
    const entry = store.get(key);
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
    }
    return entry.value;
}
function getStaleCached(key) {
    const entry = store.get(key);
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
    }
    return entry.value;
}
function setCached(key, value, ttlMs) {
    store.set(key, { value, staleAt: Date.now() + ttlMs, expiresAt: Date.now() + ttlMs * 2 });
    evictIfNeeded();
}
async function staleWhileRevalidate(key, ttlMs, producer) {
    const entry = store.get(key);
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
function cacheStats() {
    return { entries: store.size, inflight: inflight.size };
}
/**
 * Resolve a value from cache, or run `producer` once and cache the result.
 * Concurrent callers for the same key share a single in-flight promise.
 */
async function cached(key, ttlMs, producer) {
    const hit = getCached(key);
    if (hit !== undefined)
        return hit;
    const existing = inflight.get(key);
    if (existing)
        return existing;
    const promise = (async () => {
        try {
            const value = await producer();
            setCached(key, value, ttlMs);
            return value;
        }
        finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, promise);
    return promise;
}
exports.TTL = {
    CATEGORIES: 30 * 60 * 1000, // 30 minutes
    STREAMS: 10 * 60 * 1000, // 10 minutes
    TMDB: 24 * 60 * 60 * 1000, // 24 hours
    PLAYLIST: 15 * 60 * 1000 // 15 minutes
};
