import LZString from 'lz-string';
import { UserConfig } from '../types';

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
