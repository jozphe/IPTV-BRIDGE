import { Request, Response } from 'express';
import { decodeConfig } from './utils/config';
import { UserConfig, StremioManifest, StremioStream, StremioMeta } from './types';
import { getItems, MediaKind } from './iptv/provider';
import { XtreamClient } from './iptv/xtream';
import { TMDBClient } from './tmdb/tmdb';
import { rankMatches, itemsToStreams } from './tmdb/matcher';
import { cleanTitle } from './iptv/cleaner';
import { encodeItemId, decodeItemId, isItemId, ItemRef } from './utils/itemId';
import { cached, TTL } from './utils/cache';

function stremioTypeToKind(type: string): MediaKind {
  if (type === 'tv') return 'channel';
  if (type === 'movie') return 'movie';
  return 'series';
}

const FALLBACK_POSTER = 'https://iptv-bridge.vercel.app/logo.png';

export function getManifest(config: UserConfig, baseUrl?: string): StremioManifest {
  const catalogs = [];

  if (config.includeLive !== false) {
    catalogs.push({
      type: 'tv',
      id: 'iptv_live',
      name: 'IPTV Live Channels',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }]
    });
  }

  if (config.includeMovies !== false) {
    catalogs.push({
      type: 'movie',
      id: 'iptv_movies',
      name: 'IPTV Movies',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }]
    });
  }

  if (config.includeSeries !== false) {
    catalogs.push({
      type: 'series',
      id: 'iptv_series',
      name: 'IPTV Series',
      extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }, { name: 'skip', isRequired: false }]
    });
  }

  const logo = baseUrl ? `${baseUrl}/logo.png` : FALLBACK_POSTER;

  return {
    id: 'org.stremio.nuvio.iptv',
    version: '1.0.0',
    name: 'IPTV Bridge (Stremio & Nuvio)',
    description: 'Serverless Xtream & M3U IPTV Addon with TMDB Resolution, Global Search & Clean Categorization',
    logo,
    resources: [
      { name: 'catalog', types: ['tv', 'movie', 'series'] },
      // meta only for our own items; TMDB/Cinemeta handle tt/tmdb metadata
      { name: 'meta', types: ['tv', 'movie', 'series'], idPrefixes: ['iptv:'] },
      // streams for both our items AND global IMDB/TMDB ids (popular catalogs)
      { name: 'stream', types: ['movie', 'series', 'tv'], idPrefixes: ['iptv:', 'tt', 'tmdb:'] }
    ],
    types: ['tv', 'movie', 'series'],
    catalogs,
    idPrefixes: ['iptv:', 'tt', 'tmdb:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

/* ----------------------------- CATALOG ----------------------------- */

export async function handleCatalog(req: Request, res: Response) {
  try {
    const config = decodeConfig(req.params.config || '');
    const { type, extra } = req.params;

    let searchQuery = '';
    let skip = 0;
    if (extra) {
      const s = extra.match(/search=([^&/]+)/);
      if (s) searchQuery = decodeURIComponent(s[1]);
      const sk = extra.match(/skip=(\d+)/);
      if (sk) skip = parseInt(sk[1], 10);
    }

    const kind = stremioTypeToKind(type);
    let items = await getItems(config, kind);

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) => i.title.toLowerCase().includes(q) || i.cleanTitle.toLowerCase().includes(q)
      );
    }

    const page = items.slice(skip, skip + 60);

    // Enrich movie/series posters via TMDB (channels keep their logo).
    const tmdb = new TMDBClient(config.tmdbApiKey);
    const metas: StremioMeta[] = await Promise.all(
      page.map(async (item) => {
        let poster = item.logo;
        let description = `Category: ${item.category}`;
        let year: string | number | undefined = item.year;

        if (kind !== 'channel') {
          const tmdbType = kind === 'movie' ? 'movie' : 'series';
          const found = await tmdb.bestSearchMatch(
            cleanTitle(item.title).cleanTitle,
            tmdbType,
            item.year
          );
          if (found) {
            if (found.poster_path) poster = `https://image.tmdb.org/t/p/w500${found.poster_path}`;
            if (found.overview) description = found.overview;
            const rd = found.release_date || found.first_air_date;
            if (rd) year = rd.substring(0, 4);
          }
        }

        return {
          id: encodeItemId(item),
          type,
          name: cleanTitle(item.title).cleanTitle || item.title,
          poster: poster || FALLBACK_POSTER,
          posterShape: kind === 'channel' ? 'square' : 'poster',
          description,
          year
        } as StremioMeta;
      })
    );

    res.json({ metas });
  } catch (err) {
    console.error('Catalog Error:', err);
    res.json({ metas: [] });
  }
}

/* ------------------------------- META ------------------------------ */

export async function handleMeta(req: Request, res: Response) {
  try {
    const { id, type } = req.params;
    const config = decodeConfig(req.params.config || '');
    const tmdb = new TMDBClient(config.tmdbApiKey);

    if (isItemId(id)) {
      const { ref } = decodeItemId(id);
      if (!ref) {
        res.json({ meta: null });
        return;
      }

      const clean = cleanTitle(ref.t).cleanTitle || ref.t;

      // Try TMDB enrichment for movies/series. TMDB supplies artwork and
      // canonical metadata; the provider remains the source of playable videos.
      if (ref.k !== 'channel') {
        const tmdbType = ref.k === 'movie' ? 'movie' : 'series';
        const found = await tmdb.bestSearchMatch(clean, tmdbType, ref.y);
        if (found) {
          const full = await tmdb.getByTmdbId(found.id, tmdbType);
          const base = tmdb.formatToStremioMeta(full || found, tmdbType, id);

          // For series, expose provider episodes rather than every TMDB
          // episode. This prevents Stremio from showing episodes which the IPTV
          // account does not actually carry.
          if (ref.k === 'series' && config.type === 'xtream' && ref.sid !== undefined) {
            const client = new XtreamClient(config.host!, config.username!, config.password!);
            const providerEpisodes = await cached(
              `xt:all-episodes:${ref.sid}`,
              TTL.STREAMS,
              () => client.listAllEpisodes(ref.sid!)
            );
            base.videos = providerEpisodes.map((ep) => ({
              id: `${id}:${ep.season}:${ep.episode}`,
              title: ep.title,
              season: ep.season,
              episode: ep.episode,
              released: undefined,
              overview: undefined
            }));
          } else if (ref.k === 'series' && full) {
            // M3U fallback: use TMDB episodes only when the playlist does not
            // expose provider episode IDs. Stream resolution still filters the
            // flat M3U entries by season/episode.
            const seasons: number[] = (full.seasons || [])
              .map((s: any) => s.season_number)
              .filter((n: number) => n && n > 0);
            const videos: any[] = [];
            for (const sNum of seasons.slice(0, 30)) {
              const eps = await tmdb.getSeasonEpisodes(full.id, sNum);
              for (const ep of eps) {
                videos.push({
                  id: `${id}:${sNum}:${ep.episode_number}`,
                  title: ep.name || `Episode ${ep.episode_number}`,
                  season: sNum,
                  episode: ep.episode_number,
                  released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
                  thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : undefined,
                  overview: ep.overview
                });
              }
            }
            base.videos = videos;
          }

          res.json({ meta: base });
          return;
        }
      }

      // Fallback: plain meta from the IPTV item itself
      res.json({
        meta: {
          id,
          type,
          name: clean,
          poster: ref.lg || FALLBACK_POSTER,
          posterShape: ref.k === 'channel' ? 'square' : 'poster',
          background: ref.lg,
          description: ref.k === 'channel' ? 'Live IPTV channel' : 'IPTV title',
          year: ref.y
        }
      });
      return;
    }

    res.json({ meta: null });
  } catch (err) {
    console.error('Meta Error:', err);
    res.json({ meta: null });
  }
}

/* ------------------------------ STREAM ----------------------------- */

export async function handleStream(req: Request, res: Response) {
  try {
    const { id, type } = req.params;
    const config = decodeConfig(req.params.config || '');

    /* Case A: one of OUR catalog items was opened */
    if (isItemId(id)) {
      const streams = await resolveOwnItemStreams(config, id);
      res.json({ streams });
      return;
    }

    /* Case B: a popular Cinemeta/TMDB title (tt… or tmdb:…) — resolve to IPTV */
    const streams = await resolveGlobalStreams(config, id, type);
    res.json({ streams });
  } catch (err) {
    console.error('Stream Error:', err);
    res.json({ streams: [] });
  }
}

async function resolveOwnItemStreams(config: UserConfig, id: string): Promise<StremioStream[]> {
  const { ref, season, episode } = decodeItemId(id);
  if (!ref) return [];

  // Movies / channels have a direct URL
  if (ref.k !== 'series') {
    if (ref.u) {
      return [
        {
          name: '🎬 IPTV',
          title: cleanTitle(ref.t).cleanTitle || ref.t,
          url: ref.u
        }
      ];
    }
    return [];
  }

  // Series: resolve episode via Xtream get_series_info
  if (config.type === 'xtream' && ref.sid !== undefined && season !== undefined && episode !== undefined) {
    const client = new XtreamClient(config.host!, config.username!, config.password!);
    const eps = await cached(
      `xt:ep:${ref.sid}:${season}:${episode}`,
      TTL.STREAMS,
      () => client.getEpisodeStreams(ref.sid!, season, episode)
    );
    return eps.map((e) => ({
      name: `🎬 IPTV${e.quality ? ' ' + e.quality : ''}`,
      title: e.title,
      url: e.url,
      quality: e.quality
    }));
  }

  return [];
}

async function resolveGlobalStreams(
  config: UserConfig,
  id: string,
  type: string
): Promise<StremioStream[]> {
  // id forms: tt1234567 | tt1234567:1:2 | tmdb:12345 | tmdb:12345:1:2
  let season: number | undefined;
  let episode: number | undefined;
  let baseId = id;

  if (id.startsWith('tmdb:')) {
    const parts = id.split(':'); // ['tmdb','12345', s?, e?]
    baseId = `tmdb:${parts[1]}`;
    if (parts.length >= 4) {
      season = parseInt(parts[2], 10);
      episode = parseInt(parts[3], 10);
    }
  } else {
    const parts = id.split(':'); // ['tt123', s?, e?]
    baseId = parts[0];
    if (parts.length >= 3) {
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }
  }

  const isSeries = type === 'series' || season !== undefined;
  const tmdb = new TMDBClient(config.tmdbApiKey);

  // Resolve canonical title(s) + year from the id
  let titles: string[] = [];
  let year: number | undefined;

    if (baseId.startsWith('tt')) {
    const found = await tmdb.getByImdbId(baseId);
    if (found) {
      const full = await tmdb.getByTmdbId(found.details.id, found.type);
      const src = full || found.details;
      titles = tmdb.collectTitles(src, found.type);
      const rd = src.release_date || src.first_air_date;
      if (rd) year = parseInt(rd.substring(0, 4), 10);
    }
    } else if (baseId.startsWith('tmdb:')) {
    const tmdbType = isSeries ? 'series' : 'movie';
    const full = await tmdb.getByTmdbId(baseId.replace('tmdb:', ''), tmdbType);
    if (full) {
      titles = tmdb.collectTitles(full, tmdbType);
      const rd = full.release_date || full.first_air_date;
      if (rd) year = parseInt(rd.substring(0, 4), 10);
    }
  }

    // If TMDB is unavailable or the client sends a non-canonical id, use the
    // id itself as a last-resort query rather than returning a silent empty
    // response. This keeps IPTV title matching functional during TMDB outages.
    if (!titles.length) {
      const fallback = baseId.replace(/^tmdb:/, '').replace(/^tt/, '').trim();
      if (fallback.length >= 2 && !/^\d+$/.test(fallback)) titles = [fallback];
    }
    if (!titles.length) return [];

  const kind: MediaKind = isSeries ? 'series' : 'movie';
  const available = await getItems(config, kind);

    const matches = rankMatches(titles[0], available, {
    targetYear: year,
    altTitles: titles.slice(1),
    // Series entries won't have SxxEyy in the title, so don't episode-filter here
    targetSeason: config.type === 'm3u' ? season : undefined,
    targetEpisode: config.type === 'm3u' ? episode : undefined,
    minScore: 0.62
  });

  if (!matches.length) return [];

    // Movies (or M3U flat episodes): direct URLs already present
    if (!isSeries || config.type === 'm3u') {
      return itemsToStreams(matches);
    }

  // Xtream series: take best matching series, resolve the requested episode
    if (config.type === 'xtream' && season !== undefined && episode !== undefined) {
    const client = new XtreamClient(config.host!, config.username!, config.password!);
    const out: StremioStream[] = [];
    for (const m of matches.slice(0, 3)) {
      if (m.item.streamId === undefined) continue;
      const eps = await cached(
        `xt:ep:${m.item.streamId}:${season}:${episode}`,
        TTL.STREAMS,
        () => client.getEpisodeStreams(m.item.streamId!, season!, episode!)
      );
      for (const e of eps) {
        out.push({
          name: `🎬 IPTV${e.quality ? ' ' + e.quality : ''}`,
          title: `${m.item.title} • S${season}E${episode}`,
          url: e.url,
          quality: e.quality
        });
      }
      if (out.length) break; // first solid match wins
    }
    return out;
    }

    // Some clients request the series meta id itself before selecting a video.
    // Return no generic series stream rather than leaking unrelated series
    // entries into the title's source list.
    if (config.type === 'xtream' && season === undefined && episode === undefined) {
      return [];
    }

    return [];
}
