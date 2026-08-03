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
    
    // First try LZString decompression
    const decompressed = LZString.decompressFromEncodedURIComponent(encoded);
    if (decompressed) {
      return JSON.parse(decompressed);
    }

    // Fallback: standard base64 URL safe
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to decode config parameter:', err);
    return defaultConfig;
  }
}
