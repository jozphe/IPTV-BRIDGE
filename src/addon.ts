import { Request, Response } from 'express';
import { decodeConfig, validateConfig } from './utils/config';
import { isSafeProtocolId } from './utils/security';
import { UserConfig, StremioManifest, StremioCatalog, StremioStream, StremioMeta, IPTVItem, IPTVCategory } from './types';
import { getItems, getCategories, getTitleMatches, MediaKind } from './iptv/provider';
import { XtreamClient } from './iptv/xtream';
import { TMDBClient } from './tmdb/tmdb';
import { rankMatches, itemsToStreams } from './tmdb/matcher';
import { cleanTitle, categorySlug } from './iptv/cleaner';
import { encodeItemId, decodeItemId, isItemId, ItemRef } from './utils/itemId';
import { cached, TTL, secretsFromConfig } from './utils/cache';

// Cap per-media-type category rows so the manifest stays lean even for
// providers with thousands of groups. The full category list is still exposed
// as genre options on the main catalog (Discover dropdown).
const MAX_CATEGORY_ROWS = 500;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function loadManifestCategories(config: UserConfig): Promise<IPTVCategory[]> {
  try {
    // Never let a slow/down provider delay the manifest past ~6s. The provider
    // fetch itself keeps caching in the background, so a later refresh shows rows.
    return await withTimeout(getCategories(config), 6000, []);
  } catch (err) {
    console.error('Manifest categories error:', err);
    return [];
  }
}

function stremioTypeToKind(type: string): MediaKind {
  if (type === 'tv') return 'channel';
  if (type === 'movie') return 'movie';
  return 'series';
}

function getPublicLogo(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
  return `${proto}://${host}/logo.png`;
}

export async function getManifest(config: UserConfig, baseUrl?: string): Promise<StremioManifest> {
  // Pull the user's real IPTV categories (cached) so every category becomes
  // both a genre option AND its own board row: movies first, then series,
  // then live TV. `includedCategories` from the configurator is respected, so
  // deselected groups never appear.
  const categories = await loadManifestCategories(config);
  const catalogs: StremioCatalog[] = [];

  const groups: Array<{
    type: 'movie' | 'series' | 'tv';
    kind: 'movie' | 'series' | 'live';
    id: string;
    name: string;
    // Row 1: plain shelf (e.g. "Movies") shown before the IPTV-branded row.
    shelfId: string;
    shelfName: string;
    include: boolean;
  }> = [
    { type: 'movie', kind: 'movie', id: 'iptv_movies', name: 'IPTV Movies', shelfId: 'movies', shelfName: 'Movies', include: config.includeMovies !== false },
    { type: 'series', kind: 'series', id: 'iptv_series', name: 'IPTV Series', shelfId: 'series', shelfName: 'Series', include: config.includeSeries !== false },
    { type: 'tv', kind: 'live', id: 'iptv_live', name: 'IPTV Live Channels', shelfId: 'live_tv', shelfName: 'Live TV', include: config.includeLive !== false }
  ];

  for (const group of groups) {
    if (!group.include) continue;
    const typeCategories = categories.filter((cat) => cat.type === group.kind);
    // Genre options are the readable category NAMES (clients display these
    // strings verbatim — ids like `vod_45` previously showed up as garbage).
    // Deduplicated case-insensitively in case two groups share a display name
    // (e.g. "Action" and "action"), and empty names are skipped.
    const seen = new Set<string>();
    const genreOptions: string[] = [];
    for (const cat of typeCategories) {
      const name = (cat.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genreOptions.push(name);
    }

    // Row 1 — plain shelf ("Movies" / "Series" / "Live TV"): every item of
    // the type with the category dropdown. Shown first so the board opens on
    // familiar names; the IPTV-branded row follows.
    catalogs.push({
      type: group.type,
      id: group.shelfId,
      name: group.shelfName,
      genres: genreOptions,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: genreOptions },
        { name: 'skip', isRequired: false }
      ]
    });

    // Row 2 — main catalog grouping ALL movie/series/live folders together,
    // with the full category list as genres.
    catalogs.push({
      type: group.type,
      id: group.id,
      name: group.name,
      genres: genreOptions,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: genreOptions },
        { name: 'skip', isRequired: false }
      ]
    });

    // Row 3+ — one dedicated catalog (board row) per category,
    // e.g. `IPTV Movies: Action`.
    for (const cat of typeCategories.slice(0, MAX_CATEGORY_ROWS)) {
      catalogs.push({
        type: group.type,
        id: `iptv_${group.kind}_cat_${cat.id}`,
        name: `${group.name}: ${cat.name}`,
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      });
    }
  }

  // Use the bundled raster logo from public/logo.png. Stremio/Nuvio clients
  // reliably render this PNG, unlike the previous external placeholder.
  const logo = `${baseUrl || ''}/logo.png`;

  return {
    id: 'org.iptv.bridge',
    version: '1.3.0',
    name: 'IPTV Bridge',
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
    },
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..sDeakIt0DgWeZfmybeXOtg.4CyianytJ8NJmM7wv_juUymvNauoIMuz72EhdOouvhkXKEJNJ_UYV6f9WO7LHkN6USr1lGBcpvcs06asWY_26pmgQRT7AAeckgy2bTxJHqSfvq3sRkGiVcD0tYdejeTf.HkVET5t7lZd4yv_2mUiTow'
    }
  };
}

/* ----------------------------- CATALOG ----------------------------- */

/** Extract the category key from a per-category catalog id (`iptv_movie_cat_…`). */
function categoryFromCatalogId(catalogId: string): string | undefined {
  const match = catalogId.match(/^iptv_(?:movie|series|live)_cat_(.+)$/);
  return match ? match[1] : undefined;
}

/**
 * Keep only items whose category matches the requested key. The key is a
 * category id (Xtream `live_5` / `vod_45`, M3U name-slug) or a genre option
 * value; we resolve it to the canonical category NAME via the cached category
 * list, falling back to slug comparison if categories are unavailable.
 */
async function filterItemsByCategory(
  config: UserConfig,
  items: IPTVItem[],
  categoryKey: string
): Promise<IPTVItem[]> {
  const slug = categorySlug(categoryKey);
  const names = new Set<string>();
  try {
    for (const cat of await getCategories(config)) {
      if (cat.id === categoryKey || cat.name === categoryKey || categorySlug(cat.name) === slug) {
        names.add(cat.name);
      }
    }
  } catch (err) {
    console.error('Category filter error:', err);
  }
  if (!names.size) {
    return items.filter((item) => categorySlug(item.category) === slug);
  }
  // Compare case-insensitively (and via slug) so a provider that stores the
  // category name in different case on items vs categories still matches.
  const lower = new Set<string>();
  const nameSlugs = new Set<string>();
  for (const name of names) {
    lower.add(name.toLowerCase());
    nameSlugs.add(categorySlug(name));
  }
  return items.filter((item) => {
    const c = item.category || '';
    return lower.has(c.toLowerCase()) || nameSlugs.has(categorySlug(c));
  });
}

export async function handleCatalog(req: Request, res: Response) {
  try {
    const config = decodeConfig(req.params.config || '');
    if (validateConfig(config)) { res.json({ metas: [] }); return; }
    res.setHeader('Cache-Control', 'private, max-age=120, stale-while-revalidate=300');
    const fallbackPoster = getPublicLogo(req);
    const { type, id, extra } = req.params;

    let searchQuery = '';
    let genreValue = '';
    let skip = 0;
    if (extra) {
      const s = extra.match(/search=([^&/]+)/);
      if (s) searchQuery = decodeURIComponent(s[1]);
      const g = extra.match(/genre=([^&/]+)/);
      if (g) genreValue = decodeURIComponent(g[1]);
      const sk = extra.match(/skip=(\d+)/);
      if (sk) skip = parseInt(sk[1], 10);
    }

    const kind = stremioTypeToKind(type);
    let items = await getItems(config, kind);

    // Per-category catalogs (`iptv_movie_cat_<catId>` …) filter by their own
    // category; the main catalogs filter by the `genre=` extra option.
    const categoryKey = categoryFromCatalogId(id || '');
    if (categoryKey) {
      items = await filterItemsByCategory(config, items, categoryKey);
    } else if (genreValue) {
      items = await filterItemsByCategory(config, items, genreValue);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) => i.title.toLowerCase().includes(q) || i.cleanTitle.toLowerCase().includes(q)
      );
    }

    const page = items.slice(skip, skip + 60);

    // Catalogs must be fast. Do not block this response on dozens of TMDB
    // searches; Xtream/M3U artwork is enough for previews and full TMDB
    // metadata is resolved lazily when the user opens an item.
    const metas: StremioMeta[] = page.map((item) => ({
      id: encodeItemId(item),
      type,
      name: cleanTitle(item.title).cleanTitle || item.title,
      poster: item.logo || fallbackPoster,
      posterShape: kind === 'channel' ? 'square' : 'poster',
      description: `Category: ${item.category}`,
      year: item.year
    }));

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
    if (!isSafeProtocolId(id)) { res.status(400).json({ meta: null }); return; }
    const config = decodeConfig(req.params.config || '');
    if (validateConfig(config)) { res.json({ meta: null }); return; }
    res.setHeader('Cache-Control', 'private, max-age=1800, stale-while-revalidate=3600');
    const fallbackPoster = getPublicLogo(req);
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
              () => client.listAllEpisodes(ref.sid!),
              { secrets: secretsFromConfig(config) }
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
          poster: ref.lg || fallbackPoster,
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
    if (!isSafeProtocolId(id)) { res.status(400).json({ streams: [] }); return; }
    const config = decodeConfig(req.params.config || '');
    if (validateConfig(config)) { res.json({ streams: [] }); return; }
    res.setHeader('Cache-Control', 'private, max-age=30');

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
      () => client.getEpisodeStreams(ref.sid!, season, episode),
      { secrets: secretsFromConfig(config) }
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
  const kind: MediaKind = isSeries ? 'series' : 'movie';

  // Provider retrieval and TMDB resolution are independent. Start the IPTV
  // request immediately so first-load latency is the slower of the two calls,
  // rather than their combined duration.
  const availablePromise = getItems(config, kind);

  // Resolve canonical title(s) + year from the id
  let titles: string[] = [];
  let year: number | undefined;

  if (baseId.startsWith('tt')) {
    const found = await tmdb.getByImdbId(baseId);
    if (found) {
      // The find response already contains canonical title/year. Avoid a
      // second sequential TMDB details request on the time-sensitive stream
      // endpoint; alternate titles are useful but not worth delaying playback.
      const src = found.details;
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

  const available = await availablePromise;

  // Exact-title index handles the common case without scanning thousands of
  // provider entries. Fall back to ranked matching only when no identity key
  // exists (unusual provider naming).
  const indexed = await getTitleMatches(config, kind as 'movie' | 'series', titles);
  const candidatePool = indexed.length ? indexed : available;
  const matches = rankMatches(titles[0], candidatePool, {
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
        () => client.getEpisodeStreams(m.item.streamId!, season!, episode!),
        { secrets: secretsFromConfig(config) }
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
