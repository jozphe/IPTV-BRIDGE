"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTL = void 0;
exports.getCached = getCached;
exports.getStaleCached = getStaleCached;
exports.setCached = setCached;
exports.secretsFromConfig = secretsFromConfig;
exports.cached = cached;
exports.staleWhileRevalidate = staleWhileRevalidate;
exports.cacheStats = cacheStats;
/**
 * TTL cache with an OPTIONAL shared (Redis) layer.
 *
 * In-memory: on Vercel, "warm" serverless instances persist module-level
 * memory between invocations, so parsed M3U playlists, Xtream stream lists and
 * TMDB lookups are reused without an external database. Bounded by entry count
 * AND an approximate byte budget, with in-flight de-duplication.
 *
 * Shared (Upstash / Vercel KV): when `UPSTASH_REDIS_REST_URL`+`TOKEN` or
 * `KV_REST_API_URL`+`TOKEN` env vars are set, a Redis-backed layer is enabled
 * so provider fetches happen ONCE across all serverless instances instead of
 * once per warm instance. A short distributed lock prevents duplicate fetches,
 * and the value is reused by every instance until its TTL expires.
 *
 * SECURITY: provider credentials NEVER reach Redis. Values are masked before
 * storage — Xtream username/password substrings become placeholders, and any
 * URL userinfo (`scheme://user:pass@…`) is replaced too — then unmasked on
 * read with the requesting config's own credentials. Keys only ever contain
 * sha1 config fingerprints. If Redis is misconfigured or unreachable the
 * cache degrades to in-memory only instead of failing requests.
 */
const redis_1 = require("@upstash/redis");
const lz_string_1 = __importDefault(require("lz-string"));
// Placeholders used instead of credential substrings. They are only ever
// stored in the shared layer and are replaced with the real values on read.
const USER_TOKEN = '__IPTV_USER__';
const PASS_TOKEN = '__IPTV_PASS__';
const AUTH_TOKEN = '__IPTV_AUTH__';
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
    // expiresAt extends well past staleAt: staleWhileRevalidate serves this
    // value for a long time after it goes stale while refreshing in the
    // background, so a slow provider never blocks a warm request.
    store.set(key, { value, bytes, staleAt: Date.now() + ttlMs, expiresAt: Date.now() + ttlMs * 4 });
    totalBytes += bytes;
    evictIfNeeded();
}
/* ------------------------- Shared (Redis) layer ------------------------- */
let redisClient = null;
let redisStatus = 'disabled';
const REDIS_LOCK_TTL_SEC = 30;
const REDIS_POLL_MS = 6000; // bounded by Vercel Hobby's ~10s function limit
const REDIS_POLL_INTERVAL_MS = 250;
const REDIS_MIN_TTL_SEC = 60;
const REDIS_OP_TIMEOUT_MS = 1000; // a hung Redis must never hang a request
// Values are stored LZ-compressed; skip keys that still exceed the Upstash
// free-tier value ceiling (~256 KB) instead of failing the write.
const REDIS_MAX_VALUE_CHARS = 250_000;
/** Resolve `undefined` if the promise does not settle in time (best effort). */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(undefined), ms))
    ]);
}
function getRedis() {
    if (redisStatus === 'degraded')
        return null;
    if (redisClient)
        return redisClient;
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token)
        return null;
    try {
        // responseEncoding:false disables the client's base64 response decoding —
        // we do our own LZ-compressed payload handling, and it would double-decode
        // our base64 values.
        redisClient = new redis_1.Redis({ url, token, responseEncoding: false, enableTelemetry: false });
        redisStatus = 'ok';
    }
    catch (err) {
        redisStatus = 'degraded';
        console.error('[cache] Redis init failed — falling back to in-memory cache:', err);
    }
    return redisClient;
}
function degradeRedis(op, err) {
    if (redisStatus === 'ok') {
        redisStatus = 'degraded';
        console.error(`[cache] Redis ${op} failed — falling back to in-memory cache for this instance:`, err instanceof Error ? err.message : err);
    }
}
/** Extract the credentials a provider config must never persist. */
function secretsFromConfig(config) {
    const secrets = {};
    if (config.type === 'xtream') {
        if (config.username)
            secrets.user = config.username;
        if (config.password)
            secrets.pass = config.password;
    }
    else if (config.m3uUrl) {
        try {
            // url.username/password are already percent-decoded; encodeURIComponent
            // re-encodes them for the AUTH rehydration below.
            const url = new URL(config.m3uUrl);
            if (url.username) {
                secrets.m3uUser = url.username;
                secrets.user = url.username; // also mask these as raw substrings
            }
            if (url.password) {
                secrets.m3uPass = url.password;
                secrets.pass = url.password;
            }
        }
        catch {
            // Invalid URL — nothing to extract.
        }
    }
    return secrets;
}
function maskNode(node, secrets) {
    if (typeof node === 'string')
        return maskString(node, secrets);
    if (Array.isArray(node))
        return node.map((n) => maskNode(n, secrets));
    if (node && typeof node === 'object') {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            out[key] = maskNode(value, secrets);
        }
        return out;
    }
    return node;
}
function maskString(input, secrets) {
    let out = input;
    // Any URL userinfo (`scheme://user[:pass]@…`) is a credential: mask it.
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, `$1${AUTH_TOKEN}@`);
    // Known Xtream username/password substrings → placeholders (longest first,
    // so a password that is a substring of the username still masks correctly).
    const parts = [];
    if (secrets.user)
        parts.push([secrets.user, USER_TOKEN]);
    if (secrets.pass)
        parts.push([secrets.pass, PASS_TOKEN]);
    parts.sort((a, b) => b[0].length - a[0].length);
    for (const [secret, token] of parts) {
        if (secret)
            out = out.split(secret).join(token);
    }
    return out;
}
function unmaskNode(node, secrets) {
    if (typeof node === 'string')
        return unmaskString(node, secrets);
    if (Array.isArray(node))
        return node.map((n) => unmaskNode(n, secrets));
    if (node && typeof node === 'object') {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            out[key] = unmaskNode(value, secrets);
        }
        return out;
    }
    return node;
}
function authReplacement(secrets) {
    const user = secrets.m3uUser ? encodeURIComponent(secrets.m3uUser) : '';
    const pass = secrets.m3uPass ? encodeURIComponent(secrets.m3uPass) : '';
    if (!user && !pass)
        return ''; // unknown userinfo: strip it (security first)
    return `${user}${pass ? ':' + pass : ''}@`;
}
function unmaskString(input, secrets) {
    let out = input;
    if (secrets.user)
        out = out.split(USER_TOKEN).join(secrets.user);
    if (secrets.pass)
        out = out.split(PASS_TOKEN).join(secrets.pass);
    out = out.split(`${AUTH_TOKEN}@`).join(authReplacement(secrets));
    return out;
}
async function redisGetValue(key, secrets) {
    const redis = getRedis();
    if (!redis)
        return undefined;
    try {
        const raw = await withTimeout(redis.get(key), REDIS_OP_TIMEOUT_MS);
        if (raw === null || raw === undefined)
            return undefined;
        const json = lz_string_1.default.decompressFromBase64(String(raw));
        if (json === null || json === undefined)
            return undefined;
        const value = JSON.parse(json);
        return unmaskNode(value, secrets);
    }
    catch (err) {
        degradeRedis('get', err);
        return undefined;
    }
}
async function redisSetValue(key, value, ttlMs, secrets) {
    const redis = getRedis();
    if (!redis)
        return;
    try {
        const encoded = lz_string_1.default.compressToBase64(JSON.stringify(maskNode(value, secrets)));
        if (encoded.length > REDIS_MAX_VALUE_CHARS) {
            // Too large even compressed (e.g. an enormous provider list): keep this
            // key memory-only instead of failing the write and degrading the instance.
            return;
        }
        await withTimeout(redis.set(key, encoded, {
            ex: Math.max(REDIS_MIN_TTL_SEC, Math.round(ttlMs / 1000))
        }), REDIS_OP_TIMEOUT_MS);
    }
    catch (err) {
        degradeRedis('set', err);
    }
}
/** Distributed lock so only one instance fetches a missing key at a time. */
async function redisAcquireLock(key) {
    const redis = getRedis();
    if (!redis)
        return false;
    try {
        const res = await withTimeout(redis.set(`${key}:lock`, '1', { ex: REDIS_LOCK_TTL_SEC, nx: true }), REDIS_OP_TIMEOUT_MS);
        if (res === undefined) {
            // Timeout: Redis is unreliable right now — stop using it on this instance.
            degradeRedis('lock', new Error('lock acquire timed out'));
            return false;
        }
        return res === 'OK';
    }
    catch (err) {
        degradeRedis('lock', err);
        return false;
    }
}
async function redisReleaseLock(key) {
    const redis = getRedis();
    if (!redis)
        return;
    try {
        await withTimeout(redis.del(`${key}:lock`), REDIS_OP_TIMEOUT_MS);
    }
    catch {
        // Best effort — the lock expires on its own.
    }
}
async function redisPollValue(key, secrets, maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, REDIS_POLL_INTERVAL_MS));
        const value = await redisGetValue(key, secrets);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
/* ------------------------------ Public API ------------------------------ */
/**
 * Resolve a value from memory → shared Redis → run `producer` once, caching
 * the result everywhere. Concurrent callers share a single in-flight promise.
 */
async function cached(key, ttlMs, producer, opts) {
    const hit = getCached(key);
    if (hit !== undefined)
        return hit;
    if (opts?.shared !== false && getRedis()) {
        return cachedShared(key, ttlMs, producer, opts || {});
    }
    return cachedLocal(key, ttlMs, producer);
}
async function cachedLocal(key, ttlMs, producer) {
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
async function cachedShared(key, ttlMs, producer, opts) {
    const secrets = opts.secrets || {};
    const existing = inflight.get(key);
    if (existing)
        return existing;
    const promise = (async () => {
        try {
            // 1. Shared read (memory already missed).
            const remote = await redisGetValue(key, secrets);
            if (remote !== undefined) {
                setCached(key, remote, ttlMs);
                return remote;
            }
            // 2. Become the fetching instance (cross-instance de-duplication).
            if (await redisAcquireLock(key)) {
                try {
                    const value = await producer();
                    setCached(key, value, ttlMs);
                    await redisSetValue(key, value, ttlMs, secrets);
                    return value;
                }
                finally {
                    await redisReleaseLock(key);
                }
            }
            // 3. Another instance is fetching — wait for its result.
            const polled = await redisPollValue(key, secrets, REDIS_POLL_MS);
            if (polled !== undefined) {
                setCached(key, polled, ttlMs);
                return polled;
            }
            // 4. Lock lost and nothing arrived — fetch locally (no shared lock).
            const value = await producer();
            setCached(key, value, ttlMs);
            await redisSetValue(key, value, ttlMs, secrets);
            return value;
        }
        finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, promise);
    return promise;
}
/**
 * Serve a valid cached value immediately; refresh it in the background once it
 * goes stale. Falls back to `cached` (and therefore the shared layer) on miss.
 */
async function staleWhileRevalidate(key, ttlMs, producer, opts) {
    const entry = store.get(key);
    const now = Date.now();
    if (entry && entry.expiresAt > now) {
        if (entry.staleAt <= now && !inflight.has(key)) {
            const secrets = opts?.secrets || {};
            const refresh = producer()
                .then((value) => {
                setCached(key, value, ttlMs);
                if (opts?.shared !== false && getRedis()) {
                    void redisSetValue(key, value, ttlMs, secrets).catch(() => undefined);
                }
                return value;
            })
                .finally(() => inflight.delete(key));
            inflight.set(key, refresh);
            void refresh.catch(() => undefined);
        }
        return entry.value;
    }
    return cached(key, ttlMs, producer, opts);
}
function cacheStats() {
    return { entries: store.size, inflight: inflight.size, approxMb: Math.round(totalBytes / 1024 / 1024), redis: redisStatus };
}
exports.TTL = {
    // Long TTLs + stale-while-revalidate: the provider is only ever fetched
    // once per window, and stale data is served instantly while the refresh
    // happens in the background.
    CATEGORIES: 60 * 60 * 1000, // 1 hour
    STREAMS: 30 * 60 * 1000, // 30 minutes
    TMDB: 24 * 60 * 60 * 1000, // 24 hours
    PLAYLIST: 60 * 60 * 1000 // 1 hour
};
