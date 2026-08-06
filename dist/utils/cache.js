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
const MAX_ENTRIES = 600;
// Serverless instances share module memory across all configured users, so
// bound total footprint by approximate size as well as entry count. Each
// entry can be a multi-thousand-item stream list (several MB), so a pure
// entry cap is not enough to avoid an OOM kill under heavy concurrent use.
const MAX_BYTES = 128 * 1024 * 1024;
let totalBytes = 0;
function approxBytes(value) {
    try {
        return (JSON.stringify(value) || '').length * 2; // UTF-16 approx
    }
    catch {
        return 0;
    }
}
function removeEntry(key) {
    const entry = store.get(key);
    if (entry) {
        totalBytes -= entry.bytes;
        store.delete(key);
    }
}
function evictIfNeeded() {
    const now = Date.now();
    // Evict expired entries first.
    for (const [key, entry] of store) {
        if (entry.expiresAt <= now)
            removeEntry(key);
    }
    // Then drop oldest insertion-order entries until under both budgets.
    while (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined)
            break;
        removeEntry(oldestKey);
    }
}
function getCached(key) {
    const entry = store.get(key);
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        removeEntry(key);
        return undefined;
    }
    return entry.value;
}
function getStaleCached(key) {
    const entry = store.get(key);
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        removeEntry(key);
        return undefined;
    }
    return entry.value;
}
function setCached(key, value, ttlMs) {
    removeEntry(key);
    const bytes = approxBytes(value);
    store.set(key, { value, bytes, staleAt: Date.now() + ttlMs, expiresAt: Date.now() + ttlMs * 2 });
    totalBytes += bytes;
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
    return { entries: store.size, inflight: inflight.size, approxMb: Math.round(totalBytes / 1024 / 1024) };
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
