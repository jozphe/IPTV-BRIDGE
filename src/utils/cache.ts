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
import { Redis } from '@upstash/redis';
import LZString from 'lz-string';
import { UserConfig } from '../types';

interface CacheEntry<T> {
  value: T;
  bytes: number;
  staleAt: number;
  expiresAt: number;
}

/** Credential material that must never be persisted to the shared layer. */
export interface CacheSecrets {
  /** Xtream username / password. */
  user?: string;
  pass?: string;
  /** M3U playlist URL userinfo (`user:pass@`), used to rehydrate masked userinfo. */
  m3uUser?: string;
  m3uPass?: string;
}

export interface CacheOpts {
  /** Allow the value to be cached in the shared Redis layer. Default: true. */
  shared?: boolean;
  /** Credentials to mask out of the value before it reaches Redis. */
  secrets?: CacheSecrets;
}

// Placeholders used instead of credential substrings. They are only ever
// stored in the shared layer and are replaced with the real values on read.
const USER_TOKEN = '__IPTV_USER__';
const PASS_TOKEN = '__IPTV_PASS__';
const AUTH_TOKEN = '__IPTV_AUTH__';

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

/* ------------------------- Shared (Redis) layer ------------------------- */

let redisClient: Redis | null = null;
let redisStatus: 'disabled' | 'ok' | 'degraded' = 'disabled';

const REDIS_LOCK_TTL_SEC = 30;
const REDIS_POLL_MS = 6000; // bounded by Vercel Hobby's ~10s function limit
const REDIS_POLL_INTERVAL_MS = 250;
const REDIS_MIN_TTL_SEC = 60;
const REDIS_OP_TIMEOUT_MS = 1000; // a hung Redis must never hang a request
// Values are stored LZ-compressed; skip keys that still exceed the Upstash
// free-tier value ceiling (~256 KB) instead of failing the write.
const REDIS_MAX_VALUE_CHARS = 250_000;

/** Resolve `undefined` if the promise does not settle in time (best effort). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

function getRedis(): Redis | null {
  if (redisStatus === 'degraded') return null;
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    // responseEncoding:false disables the client's base64 response decoding —
    // we do our own LZ-compressed payload handling, and it would double-decode
    // our base64 values.
    redisClient = new Redis({ url, token, responseEncoding: false, enableTelemetry: false });
    redisStatus = 'ok';
  } catch (err) {
    redisStatus = 'degraded';
    console.error('[cache] Redis init failed — falling back to in-memory cache:', err);
  }
  return redisClient;
}

function degradeRedis(op: string, err: unknown): void {
  if (redisStatus === 'ok') {
    redisStatus = 'degraded';
    console.error(
      `[cache] Redis ${op} failed — falling back to in-memory cache for this instance:`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Extract the credentials a provider config must never persist. */
export function secretsFromConfig(config: UserConfig): CacheSecrets {
  const secrets: CacheSecrets = {};
  if (config.type === 'xtream') {
    if (config.username) secrets.user = config.username;
    if (config.password) secrets.pass = config.password;
  } else if (config.m3uUrl) {
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
    } catch {
      // Invalid URL — nothing to extract.
    }
  }
  return secrets;
}

function maskNode(node: unknown, secrets: CacheSecrets): unknown {
  if (typeof node === 'string') return maskString(node, secrets);
  if (Array.isArray(node)) return node.map((n) => maskNode(n, secrets));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = maskNode(value, secrets);
    }
    return out;
  }
  return node;
}

function maskString(input: string, secrets: CacheSecrets): string {
  let out = input;
  // Any URL userinfo (`scheme://user[:pass]@…`) is a credential: mask it.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, `$1${AUTH_TOKEN}@`);
  // Known Xtream username/password substrings → placeholders (longest first,
  // so a password that is a substring of the username still masks correctly).
  const parts: Array<[string, string]> = [];
  if (secrets.user) parts.push([secrets.user, USER_TOKEN]);
  if (secrets.pass) parts.push([secrets.pass, PASS_TOKEN]);
  parts.sort((a, b) => b[0].length - a[0].length);
  for (const [secret, token] of parts) {
    if (secret) out = out.split(secret).join(token);
  }
  return out;
}

function unmaskNode(node: unknown, secrets: CacheSecrets): unknown {
  if (typeof node === 'string') return unmaskString(node, secrets);
  if (Array.isArray(node)) return node.map((n) => unmaskNode(n, secrets));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = unmaskNode(value, secrets);
    }
    return out;
  }
  return node;
}

function authReplacement(secrets: CacheSecrets): string {
  const user = secrets.m3uUser ? encodeURIComponent(secrets.m3uUser) : '';
  const pass = secrets.m3uPass ? encodeURIComponent(secrets.m3uPass) : '';
  if (!user && !pass) return ''; // unknown userinfo: strip it (security first)
  return `${user}${pass ? ':' + pass : ''}@`;
}

function unmaskString(input: string, secrets: CacheSecrets): string {
  let out = input;
  if (secrets.user) out = out.split(USER_TOKEN).join(secrets.user);
  if (secrets.pass) out = out.split(PASS_TOKEN).join(secrets.pass);
  out = out.split(`${AUTH_TOKEN}@`).join(authReplacement(secrets));
  return out;
}

async function redisGetValue<T>(key: string, secrets: CacheSecrets): Promise<T | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    const raw = await withTimeout(redis.get<string>(key), REDIS_OP_TIMEOUT_MS);
    if (raw === null || raw === undefined) return undefined;
    const json = LZString.decompressFromBase64(String(raw));
    if (json === null || json === undefined) return undefined;
    const value = JSON.parse(json) as T;
    return unmaskNode(value, secrets) as T;
  } catch (err) {
    degradeRedis('get', err);
    return undefined;
  }
}

async function redisSetValue(key: string, value: unknown, ttlMs: number, secrets: CacheSecrets): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const encoded = LZString.compressToBase64(JSON.stringify(maskNode(value, secrets)));
    if (encoded.length > REDIS_MAX_VALUE_CHARS) {
      // Too large even compressed (e.g. an enormous provider list): keep this
      // key memory-only instead of failing the write and degrading the instance.
      return;
    }
    await withTimeout(redis.set(key, encoded, {
      ex: Math.max(REDIS_MIN_TTL_SEC, Math.round(ttlMs / 1000))
    }), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    degradeRedis('set', err);
  }
}

/** Distributed lock so only one instance fetches a missing key at a time. */
async function redisAcquireLock(key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await withTimeout(redis.set(`${key}:lock`, '1', { ex: REDIS_LOCK_TTL_SEC, nx: true }), REDIS_OP_TIMEOUT_MS);
    if (res === undefined) {
      // Timeout: Redis is unreliable right now — stop using it on this instance.
      degradeRedis('lock', new Error('lock acquire timed out'));
      return false;
    }
    return res === 'OK';
  } catch (err) {
    degradeRedis('lock', err);
    return false;
  }
}

async function redisReleaseLock(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await withTimeout(redis.del(`${key}:lock`), REDIS_OP_TIMEOUT_MS);
  } catch {
    // Best effort — the lock expires on its own.
  }
}

async function redisPollValue<T>(key: string, secrets: CacheSecrets, maxMs: number): Promise<T | undefined> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REDIS_POLL_INTERVAL_MS));
    const value = await redisGetValue<T>(key, secrets);
    if (value !== undefined) return value;
  }
  return undefined;
}

/* ------------------------------ Public API ------------------------------ */

/**
 * Resolve a value from memory → shared Redis → run `producer` once, caching
 * the result everywhere. Concurrent callers share a single in-flight promise.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
  opts?: CacheOpts
): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== undefined) return hit;

  if (opts?.shared !== false && getRedis()) {
    return cachedShared(key, ttlMs, producer, opts || {});
  }
  return cachedLocal(key, ttlMs, producer);
}

async function cachedLocal<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
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

async function cachedShared<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
  opts: CacheOpts
): Promise<T> {
  const secrets = opts.secrets || {};
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = (async () => {
    try {
      // 1. Shared read (memory already missed).
      const remote = await redisGetValue<T>(key, secrets);
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
        } finally {
          await redisReleaseLock(key);
        }
      }

      // 3. Another instance is fetching — wait for its result.
      const polled = await redisPollValue<T>(key, secrets, REDIS_POLL_MS);
      if (polled !== undefined) {
        setCached(key, polled, ttlMs);
        return polled;
      }

      // 4. Lock lost and nothing arrived — fetch locally (no shared lock).
      const value = await producer();
      setCached(key, value, ttlMs);
      await redisSetValue(key, value, ttlMs, secrets);
      return value;
    } finally {
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
export async function staleWhileRevalidate<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
  opts?: CacheOpts
): Promise<T> {
  const entry = store.get(key) as CacheEntry<T> | undefined;
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

export function cacheStats(): { entries: number; inflight: number; approxMb: number; redis: string } {
  return { entries: store.size, inflight: inflight.size, approxMb: Math.round(totalBytes / 1024 / 1024), redis: redisStatus };
}

export const TTL = {
  CATEGORIES: 30 * 60 * 1000, // 30 minutes
  STREAMS: 10 * 60 * 1000, // 10 minutes
  TMDB: 24 * 60 * 60 * 1000, // 24 hours
  PLAYLIST: 15 * 60 * 1000 // 15 minutes
};
