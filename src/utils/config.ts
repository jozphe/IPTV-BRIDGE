import LZString from 'lz-string';
import { UserConfig } from '../types';
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
  const jsonStr = JSON.stringify(config);
  return LZString.compressToEncodedURIComponent(jsonStr);
}

export function decodeConfig(encoded: string): UserConfig {
  try {
    if (!encoded) return defaultConfig;
    if (encoded.length > MAX_CONFIG_LENGTH) return defaultConfig;

    // Some clients preserve an escaped path segment when opening an addon
    // link. Decode it before passing it to LZString.
    const safeEncoded = decodeURIComponent(encoded);
    
    // First try LZString decompression
    const decompressed = LZString.decompressFromEncodedURIComponent(safeEncoded);
    if (decompressed) {
      return normalizeConfig(JSON.parse(decompressed));
    }

    // Fallback: standard base64 URL safe
    const base64 = safeEncoded.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return normalizeConfig(JSON.parse(jsonStr));
  } catch (err) {
    console.error('Failed to decode config parameter:', err);
    return defaultConfig;
  }
}

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
  const config: UserConfig = {
    ...defaultConfig,
    ...value,
    type: value.type === 'xtream' ? 'xtream' : 'm3u'
  };
  if (Array.isArray(value.includedCategories)) {
    config.includedCategories = value.includedCategories.map(String).filter(Boolean);
  }
  return config;
}
