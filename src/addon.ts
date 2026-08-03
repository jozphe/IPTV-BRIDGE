import { Request, Response } from 'express';
import { decodeConfig } from './utils/config';
import { UserConfig, StremioManifest, StremioStream, StremioMeta } from './types';
import { getItems, MediaKind } from './iptv/provider';
import { TMDBClient } from './tmdb/tmdb';
import { filterAndSortMatchingStreams } from './tmdb/matcher';

function stremioTypeToKind(type: string): MediaKind {
  if (type === 'tv') return 'channel';
  if (type === 'movie') return 'movie';
  return 'series';
}

export function getManifest(config: UserConfig): StremioManifest {
  const catalogs = [];

  if (config.includeLive !== false) {
    catalogs.push({
      type: 'tv',
      id: 'iptv_live',
      name: 'IPTV Live Channels',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
    });
  }

  if (config.includeMovies !== false) {
    catalogs.push({
      type: 'movie',
      id: 'iptv_movies',
      name: 'IPTV Movies',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
    });
  }

  if (config.includeSeries !== false) {
    catalogs.push({
      type: 'series',
      id: 'iptv_series',
      name: 'IPTV Series',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
    });
  }

  return {
    id: 'org.stremio.nuvio.iptv',
    version: '1.0.0',
    name: 'IPTV Bridge (Stremio & Nuvio)',
    description: 'Serverless Xtream & M3U IPTV Addon with TMDB Resolution, Global Search & Clean Categorization',
    logo: 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs,
    idPrefixes: ['tt', 'tmdb:', 'iptv:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

export async function handleCatalog(req: Request, res: Response) {
  try {
    const configParam = req.params.config || '';
    const config = decodeConfig(configParam);
    const { type, id, extra } = req.params;

    let searchQuery = '';
    if (extra) {
      const match = extra.match(/search=([^&]+)/);
      if (match) searchQuery = decodeURIComponent(match[1]);
    }

    let items = await getItems(config, stremioTypeToKind(type));

    // Filter search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(item => item.title.toLowerCase().includes(q) || item.cleanTitle.toLowerCase().includes(q));
    }

    // Cap results for catalog view responsiveness
    items = items.slice(0, 100);

    // Format Stremio Metas
    const metas: StremioMeta[] = items.map(item => ({
      id: `iptv:${encodeURIComponent(item.url || item.id)}`,
      type: type,
      name: item.title,
      poster: item.logo || 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
      description: `Category: ${item.category}`
    }));

    res.json({ metas });
  } catch (err) {
    console.error('Catalog Error:', err);
    res.json({ metas: [] });
  }
}

export async function handleMeta(req: Request, res: Response) {
  try {
    const { id, type } = req.params;
    const configParam = req.params.config || '';
    const config = decodeConfig(configParam);

    if (id.startsWith('iptv:')) {
      const rawUrl = decodeURIComponent(id.replace(/^iptv:/, ''));
      res.json({
        meta: {
          id,
          type,
          name: 'IPTV Stream',
          poster: 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
          description: 'Direct IPTV Stream'
        }
      });
      return;
    }

    // Handle IMDB / TMDB IDs
    const tmdb = new TMDBClient(config.tmdbApiKey);
    if (id.startsWith('tt')) {
      const resData = await tmdb.getByImdbId(id);
      if (resData) {
        const meta = tmdb.formatToStremioMeta(resData.details, resData.type);
        res.json({ meta });
        return;
      }
    } else if (id.startsWith('tmdb:')) {
      const tmdbId = id.replace('tmdb:', '');
      const details = await tmdb.getByTmdbId(tmdbId, type === 'movie' ? 'movie' : 'series');
      if (details) {
        const meta = tmdb.formatToStremioMeta(details, type === 'movie' ? 'movie' : 'series');
        res.json({ meta });
        return;
      }
    }

    res.json({ meta: null });
  } catch (err) {
    console.error('Meta Error:', err);
    res.json({ meta: null });
  }
}

export async function handleStream(req: Request, res: Response) {
  try {
    const { id, type } = req.params;
    const configParam = req.params.config || '';
    const config = decodeConfig(configParam);

    // 1. Direct IPTV Stream URL ID
    if (id.startsWith('iptv:')) {
      const rawUrl = decodeURIComponent(id.replace(/^iptv:/, ''));
      const stream: StremioStream = {
        name: 'IPTV Direct',
        title: 'IPTV Live Stream',
        url: rawUrl
      };
      res.json({ streams: [stream] });
      return;
    }

    // 2. Global IMDB / TMDB ID resolution (Movie or Show episode requested in Stremio / Nuvio)
    let targetTitle = '';
    let targetYear: number | undefined;
    let targetSeason: number | undefined;
    let targetEpisode: number | undefined;

    // Extract episode info if present (e.g. tt123456:1:2 or tmdb:12345:1:2)
    const idParts = id.split(':');
    const baseId = idParts.length >= 2 && !id.startsWith('tmdb:') ? idParts[0] : idParts.slice(0, 2).join(':');

    if (idParts.length > 2) {
      targetSeason = parseInt(idParts[idParts.length - 2], 10);
      targetEpisode = parseInt(idParts[idParts.length - 1], 10);
    }

    const tmdb = new TMDBClient(config.tmdbApiKey);

    if (baseId.startsWith('tt')) {
      const tmdbMatch = await tmdb.getByImdbId(baseId);
      if (tmdbMatch) {
        targetTitle = tmdbMatch.details.title || tmdbMatch.details.name || tmdbMatch.details.original_title;
        const releaseDate = tmdbMatch.details.release_date || tmdbMatch.details.first_air_date;
        if (releaseDate) targetYear = parseInt(releaseDate.substring(0, 4), 10);
      }
    } else if (baseId.startsWith('tmdb:')) {
      const tmdbId = baseId.replace('tmdb:', '');
      const details = await tmdb.getByTmdbId(tmdbId, type === 'movie' ? 'movie' : 'series');
      if (details) {
        targetTitle = details.title || details.name || details.original_title;
        const releaseDate = details.release_date || details.first_air_date;
        if (releaseDate) targetYear = parseInt(releaseDate.substring(0, 4), 10);
      }
    }

    if (!targetTitle) {
      res.json({ streams: [] });
      return;
    }

    // Fetch user streams to match against targetTitle
    const availableStreams = await getItems(config, stremioTypeToKind(type));

    const streams = filterAndSortMatchingStreams(
      targetTitle,
      availableStreams,
      targetYear,
      targetSeason,
      targetEpisode
    );

    res.json({ streams });
  } catch (err) {
    console.error('Stream Error:', err);
    res.json({ streams: [] });
  }
}
