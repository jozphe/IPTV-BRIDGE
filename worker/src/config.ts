// User config codec (per-user credentials embedded in the manifest URL) +
// provider fingerprint for cache keys. Ported from the Node addon; uses
// lz-string (pure JS, bundles fine on Workers) and atob instead of Buffer.

import LZString from 'lz-string';
import { UserConfig } from './types';
import { isSafeUpstreamUrl } from './security';

const MAX_CONFIG_LENGTH = 16_384;

export const defaultConfig: UserConfig = {
  type: 'm3u',
  includeLive: true,
  includeMovies: true,
  includeSeries: true,
  streamType: 'auto'
};

export function encodeConfig(config: UserConfig): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(config));
}

function base64UrlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  // Decode UTF-8 bytes.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeConfig(encoded: string): UserConfig {
  try {
    if (!encoded) return defaultConfig;
    if (encoded.length > MAX_CONFIG_LENGTH) return defaultConfig;

    const safe = decodeURIComponent(encoded);

    const decompressed = LZString.decompressFromEncodedURIComponent(safe);
    if (decompressed) return normalizeConfig(JSON.parse(decompressed));

    // Fallback: plain base64url JSON.
    return normalizeConfig(JSON.parse(base64UrlToString(safe)));
  } catch {
    return defaultConfig;
  }
}

/** Returns an error string if the config is unusable, else null. */
export function validateConfig(config: UserConfig): string | null {
  if (config.type === 'xtream') {
    if (!config.host || !config.username || !config.password) return 'Xtream host, username and password are required.';
    if (config.username.length > 512 || config.password.length > 512) return 'Provider credentials are too long.';
    if (!isSafeUpstreamUrl(config.host)) return 'Xtream host must be a valid public HTTP or HTTPS URL.';
  } else {
    if (!config.m3uUrl) return 'M3U playlist URL is required.';
    if (!isSafeUpstreamUrl(config.m3uUrl)) return 'M3U URL must be a valid public HTTP or HTTPS URL.';
  }
  if (config.tmdbApiKey && config.tmdbApiKey.length > 512) return 'TMDB key is too long.';
  if (config.includedCategories && config.includedCategories.length > 2000) return 'Too many categories selected.';
  return null;
}

function normalizeConfig(value: any): UserConfig {
  if (!value || typeof value !== 'object') return defaultConfig;
  const config: UserConfig = { ...defaultConfig, ...value, type: value.type === 'xtream' ? 'xtream' : 'm3u' };
  if (Array.isArray(value.includedCategories)) {
    config.includedCategories = value.includedCategories.map(String).filter(Boolean);
  }
  return config;
}

/** Stable short fingerprint of the provider identity, for per-user cache keys. */
export function configFingerprint(config: UserConfig): string {
  const raw =
    config.type === 'xtream'
      ? `xt|${config.host}|${config.username}|${config.password}`
      : `m3u|${config.m3uUrl}`;
  // FNV-1a 32-bit (sync, dependency-free); collisions are irrelevant for a cache key.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
