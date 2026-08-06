// Shared types for the Cloudflare Worker (per-user credentials model).

export interface Env {
  ASSETS: Fetcher;
  // Optional fallback TMDB key when a user did not provide their own.
  TMDB_FALLBACK_KEY?: string;
}

export interface UserConfig {
  type: 'xtream' | 'm3u';
  // Xtream credentials
  host?: string;
  username?: string;
  password?: string;
  // M3U credential
  m3uUrl?: string;
  // TMDB key (per user, optional)
  tmdbApiKey?: string;
  // Included category ids / names
  includedCategories?: string[];
  // Include types
  includeLive?: boolean;
  includeMovies?: boolean;
  includeSeries?: boolean;
  streamType?: 'm3u8' | 'ts' | 'auto';
}

export type MediaKind = 'channel' | 'movie' | 'series';
export type StremioType = 'tv' | 'movie' | 'series';

export interface ProviderItem {
  id: string;
  streamId?: string | number;
  title: string;
  cleanTitle: string;
  type: MediaKind;
  category: string;
  logo?: string;
  url?: string;
  year?: number;
  season?: number;
  episode?: number;
  containerExtension?: string;
}

export interface Genre {
  id: string;
  name: string;
}

// Stremio protocol shapes
export interface StremioCatalog {
  type: string;
  id: string;
  name: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[]; optionsLimit?: number }>;
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  resources: Array<string | { name: string; types: string[]; idPrefixes?: string[] }>;
  types: string[];
  catalogs: StremioCatalog[];
  idPrefixes?: string[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean };
  stremioAddonsConfig?: { issuer: string; signature: string };
}

export interface StremioMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape';
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  year?: number | string;
  genres?: string[];
  imdbRating?: string;
  videos?: Array<{
    id: string;
    title: string;
    released?: string;
    thumbnail?: string;
    overview?: string;
    season?: number;
    episode?: number;
  }>;
}

export interface StremioStream {
  name: string;
  title: string;
  url: string;
  quality?: string;
  behaviorHints?: Record<string, unknown>;
}
