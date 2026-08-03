import axios from 'axios';
import { StremioMeta } from '../types';

export class TMDBClient {
  private apiKey: string;
  private baseUrl = 'https://api.themoviedb.org/3';

  constructor(apiKey?: string) {
    // If no custom key provided, fallback to a public TMDB read key or standard API key
    this.apiKey = apiKey && apiKey.trim() ? apiKey.trim() : 'a82e9b89737119f91a508f71052fb58f';
  }

  public async getByImdbId(imdbId: string): Promise<{ type: 'movie' | 'series'; details: any } | null> {
    try {
      const url = `${this.baseUrl}/find/${encodeURIComponent(imdbId)}?api_key=${this.apiKey}&external_source=imdb_id`;
      const res = await axios.get(url, { timeout: 8000 });
      const data = res.data;

      if (data.movie_results && data.movie_results.length > 0) {
        return { type: 'movie', details: data.movie_results[0] };
      }
      if (data.tv_results && data.tv_results.length > 0) {
        return { type: 'series', details: data.tv_results[0] };
      }
      return null;
    } catch (err) {
      console.error(`TMDB lookup by IMDB ID ${imdbId} failed:`, err);
      return null;
    }
  }

  public async getByTmdbId(tmdbId: number | string, type: 'movie' | 'series'): Promise<any | null> {
    try {
      const endpoint = type === 'movie' ? 'movie' : 'tv';
      const cleanId = String(tmdbId).replace(/^tmdb:/, '');
      const url = `${this.baseUrl}/${endpoint}/${encodeURIComponent(cleanId)}?api_key=${this.apiKey}&append_to_response=external_ids,credits`;
      const res = await axios.get(url, { timeout: 8000 });
      return res.data;
    } catch (err) {
      console.error(`TMDB lookup by ID ${tmdbId} failed:`, err);
      return null;
    }
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

  public formatToStremioMeta(tmdbData: any, type: 'movie' | 'series'): StremioMeta {
    const isMovie = type === 'movie';
    const id = tmdbData.external_ids?.imdb_id || `tmdb:${tmdbData.id}`;
    const name = isMovie ? tmdbData.title || tmdbData.original_title : tmdbData.name || tmdbData.original_name;
    const releaseDate = isMovie ? tmdbData.release_date : tmdbData.first_air_date;
    const year = releaseDate ? releaseDate.substring(0, 4) : undefined;

    return {
      id,
      type: isMovie ? 'movie' : 'series',
      name: name || 'Unknown Title',
      poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined,
      background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : undefined,
      description: tmdbData.overview,
      year,
      imdbRating: tmdbData.vote_average ? String(Math.round(tmdbData.vote_average * 10) / 10) : undefined,
      genres: tmdbData.genres ? tmdbData.genres.map((g: any) => g.name) : []
    };
  }
}
