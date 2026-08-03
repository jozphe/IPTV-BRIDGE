export interface UserConfig {
  type: 'xtream' | 'm3u';
  // Xtream credentials
  host?: string;
  username?: string;
  password?: string;
  // M3U credential
  m3uUrl?: string;
  // TMDB Key
  tmdbApiKey?: string;
  // Included Category IDs / Names
  includedCategories?: string[];
  // Include types (live, movie, series)
  includeLive?: boolean;
  includeMovies?: boolean;
  includeSeries?: boolean;
  // Additional options
  streamType?: 'm3u8' | 'ts' | 'auto';
}

export interface IPTVItem {
  id: string;
  streamId?: string | number;
  title: string;
  cleanTitle: string;
  type: 'channel' | 'movie' | 'series';
  category: string;
  logo?: string;
  url?: string;
  year?: number;
  season?: number;
  episode?: number;
  containerExtension?: string;
  tmdbId?: number | string;
  imdbId?: string;
}

export interface IPTVCategory {
  id: string;
  name: string;
  type: 'live' | 'movie' | 'series';
}

// Stremio Protocol Types
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
  behaviorHints?: {
    configurable?: boolean;
    configurationRequired?: boolean;
  };
}

export interface StremioCatalog {
  type: string;
  id: string;
  name: string;
  genres?: string[];
  extra?: Array<{
    name: string;
    isRequired?: boolean;
    options?: string[];
    optionsLimit?: number;
  }>;
}

export interface StremioMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  year?: number | string;
  genres?: string[];
  imdbRating?: string;
  cast?: string[];
  director?: string[];
  videos?: Array<{
    id: string;
    title: string;
    released?: string;
    thumbnail?: string;
    season?: number;
    episode?: number;
  }>;
}

export interface StremioStream {
  name: string;
  title: string;
  url: string;
  quality?: string;
  behaviorHints?: {
    notResponseOrEncrypted?: boolean;
    proxyHeaders?: Record<string, string>;
  };
}
