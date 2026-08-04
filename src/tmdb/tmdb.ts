import axios from 'axios';
import { StremioMeta } from '../types';
import { cached, TTL } from '../utils/cache';

export class TMDBClient {
  private apiKey: string;
  private baseUrl = 'https://api.themoviedb.org/3';

  constructor(apiKey?: string) {
    // If no custom key provided, fallback to a public TMDB read key or standard API key
    this.apiKey = apiKey && apiKey.trim() ? apiKey.trim() : 'a82e9b89737119f91a508f71052fb58f';
  }

  public async getByImdbId(imdbId: string): Promise<{ type: 'movie' | 'series'; details: any } | null> {
    return cached(`tmdb:find:${imdbId}`, TTL.TMDB, async () => {
      try {
        const url = `${this.baseUrl}/find/${encodeURIComponent(imdbId)}?api_key=${this.apiKey}&external_source=imdb_id`;
        const res = await axios.get(url, { timeout: 8000 });
        const data = res.data;

        if (data.movie_results && data.movie_results.length > 0) {
          return { type: 'movie' as const, details: data.movie_results[0] };
        }
        if (data.tv_results && data.tv_results.length > 0) {
          return { type: 'series' as const, details: data.tv_results[0] };
        }
        return null;
      } catch (err) {
        console.error(`TMDB lookup by IMDB ID ${imdbId} failed:`, err);
        return null;
      }
    });
  }

  public async getByTmdbId(tmdbId: number | string, type: 'movie' | 'series'): Promise<any | null> {
    const cleanId = String(tmdbId).replace(/^tmdb:/, '');
    return cached(`tmdb:${type}:${cleanId}`, TTL.TMDB, async () => {
      try {
        const endpoint = type === 'movie' ? 'movie' : 'tv';
        const url = `${this.baseUrl}/${endpoint}/${encodeURIComponent(cleanId)}?api_key=${this.apiKey}&append_to_response=external_ids,credits,alternative_titles`;
        const res = await axios.get(url, { timeout: 8000 });
        return res.data;
      } catch (err) {
        console.error(`TMDB lookup by ID ${tmdbId} failed:`, err);
        return null;
      }
    });
  }

  /** Collect the primary + alternative titles for better IPTV matching. */
  public collectTitles(tmdbData: any, type: 'movie' | 'series'): string[] {
    const titles = new Set<string>();
    const primary = type === 'movie'
      ? (tmdbData.title || tmdbData.original_title)
      : (tmdbData.name || tmdbData.original_name);
    if (primary) titles.add(primary);
    if (tmdbData.original_title) titles.add(tmdbData.original_title);
    if (tmdbData.original_name) titles.add(tmdbData.original_name);

    const alts = tmdbData.alternative_titles?.titles || tmdbData.alternative_titles?.results || [];
    for (const a of alts) {
      if (a?.title) titles.add(a.title);
    }
    return [...titles];
  }

  /** Fetch the episode list for a season (for series meta). */
  public async getSeasonEpisodes(tmdbId: number | string, season: number): Promise<any[]> {
    const cleanId = String(tmdbId).replace(/^tmdb:/, '');
    return cached(`tmdb:season:${cleanId}:${season}`, TTL.TMDB, async () => {
      try {
        const url = `${this.baseUrl}/tv/${encodeURIComponent(cleanId)}/season/${season}?api_key=${this.apiKey}`;
        const res = await axios.get(url, { timeout: 8000 });
        return res.data?.episodes || [];
      } catch {
        return [];
      }
    });
  }

  public async searchMedia(query: string, type: 'movie' | 'series' | 'all' = 'all'): Promise<any[]> {
    try {
      const results: any[] = [];
      
      if (type === 'movie' || type === 'all') {
        const movieUrl = `${this.baseUrl}/search/movie?api_key=${this.apiKey}&query=${encodeURIComponent(query)}`;
        const mRes = await axios.get(movieUrl, { timeout: 8000 });
        if (mRes.data?.results) {
          results.push(...mRes.data.results.map((item: any) => ({ ...item, media_type: 'movie' })));
        }
      }

      if (type === 'series' || type === 'all') {
        const tvUrl = `${this.baseUrl}/search/tv?api_key=${this.apiKey}&query=${encodeURIComponent(query)}`;
        const tvRes = await axios.get(tvUrl, { timeout: 8000 });
        if (tvRes.data?.results) {
          results.push(...tvRes.data.results.map((item: any) => ({ ...item, media_type: 'series' })));
        }
      }

      return results;
    } catch (err) {
      console.error(`TMDB search failed for query "${query}":`, err);
      return [];
    }
  }

  public formatToStremioMeta(tmdbData: any, type: 'movie' | 'series', overrideId?: string): StremioMeta {
    const isMovie = type === 'movie';
    const id = overrideId || tmdbData.external_ids?.imdb_id || `tmdb:${tmdbData.id}`;
    const name = isMovie ? tmdbData.title || tmdbData.original_title : tmdbData.name || tmdbData.original_name;
    const releaseDate = isMovie ? tmdbData.release_date : tmdbData.first_air_date;
    const year = releaseDate ? releaseDate.substring(0, 4) : undefined;

    return {
      id,
      type: isMovie ? 'movie' : 'series',
      name: name || 'Unknown Title',
      poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined,
      background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : undefined,
      logo: undefined,
      description: tmdbData.overview,
      year,
      releaseInfo: year,
      imdbRating: tmdbData.vote_average ? String(Math.round(tmdbData.vote_average * 10) / 10) : undefined,
      genres: tmdbData.genres ? tmdbData.genres.map((g: any) => g.name) : []
    };
  }

  /** Search and return the single best TMDB match for a raw title/year. */
  public async bestSearchMatch(
    title: string,
    type: 'movie' | 'series',
    year?: number
  ): Promise<any | null> {
    const key = `tmdb:search:${type}:${title.toLowerCase()}:${year || ''}`;
    return cached(key, TTL.TMDB, async () => {
      try {
        const endpoint = type === 'movie' ? 'movie' : 'tv';
        let url = `${this.baseUrl}/search/${endpoint}?api_key=${this.apiKey}&query=${encodeURIComponent(title)}`;
        if (year) url += type === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`;
        const res = await axios.get(url, { timeout: 8000 });
        const results = res.data?.results;
        return Array.isArray(results) && results.length ? results[0] : null;
      } catch {
        return null;
      }
    });
  }
}
