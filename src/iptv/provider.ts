import { UserConfig, IPTVItem, IPTVCategory } from '../types';
import { XtreamClient } from './xtream';
import { parseM3UPlaylist, ParsedM3U } from './m3u';
import { cached, staleWhileRevalidate, TTL, secretsFromConfig } from '../utils/cache';
import crypto from 'crypto';
import { titleIdentity, categorySlug } from './cleaner';

export type MediaKind = 'channel' | 'movie' | 'series';
type TitleIndex = Map<string, IPTVItem[]>;

function configFingerprint(config: UserConfig): string {
  const raw = config.type === 'xtream'
    ? `xt|${config.host}|${config.username}|${config.password}`
    : `m3u|${config.m3uUrl}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** Resolve the configured category limit (0 = load everything). */
function categoryLimit(config: UserConfig): number {
  const n = Number(config.categoryLimit) || 0;
  return n > 0 ? Math.min(Math.floor(n), 25) : 0;
}

/** Cap on how many per-category provider requests run at once. */
const CATEGORY_FETCH_CONCURRENCY = 6;

/**
 * Reduce a category list to the config's limit. The user's `includedCategories`
 * (ids/names/slugs) are honored when they match and padded with the provider's
 * next categories up to the limit (so stale picks never undershoot "load N");
 * a selection matching nothing falls back to the first N per type. The cap
 * applies PER TYPE (e.g. 3 movie + 3 series + 3 live with a limit of 3).
 */
function limitedCategoryList(all: IPTVCategory[], config: UserConfig): IPTVCategory[] {
  const limit = categoryLimit(config);
  if (!limit) return all;

  const chosen = config.includedCategories && config.includedCategories.length
    ? new Set(config.includedCategories.map(String))
    : null;
  let cats = all;
  if (chosen) {
    const filtered = all.filter((c) =>
      chosen.has(c.id) || chosen.has(c.name) || chosen.has(categorySlug(c.name))
    );
    if (filtered.length) {
      // Keep user picks, then pad with unselected categories so the requested
      // number still loads if some picks are stale.
      const pickedIds = new Set(filtered.map((c) => c.id));
      cats = [...filtered, ...all.filter((c) => !pickedIds.has(c.id))];
    }
  }

  const out: IPTVCategory[] = [];
  for (const type of ['live', 'movie', 'series'] as const) {
    out.push(...cats.filter((c) => c.type === type).slice(0, limit));
  }
  return out;
}

/** Fetch the provider's FULL category list (never trimmed). */
async function fetchAllCategories(config: UserConfig): Promise<IPTVCategory[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return staleWhileRevalidate(`xt:cats:${fp}`, TTL.CATEGORIES, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getCategories();
    }, { secrets: secretsFromConfig(config) });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await fetchParsedM3U(config);
    return parsed.categories;
  }

  return [];
}

/** Parse the M3U source once, cached per-provider (shared by items & categories). */
function fetchParsedM3U(config: UserConfig): Promise<ParsedM3U> {
  const fp = configFingerprint(config);
  return staleWhileRevalidate(`m3u:parsed:${fp}`, TTL.PLAYLIST, () =>
    parseM3UPlaylist(config.m3uUrl!)
  , { secrets: secretsFromConfig(config) });
}

export async function getItems(config: UserConfig, kind: MediaKind): Promise<IPTVItem[]> {
  const fp = configFingerprint(config);
  const secrets = secretsFromConfig(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    const xtType = kind === 'channel' ? 'live' : kind;
    const limit = categoryLimit(config);
    if (limit) {
      // FAST PATH: fetch only the limited categories, one small request each
      // (cached per category), instead of the panel's giant full-type
      // download. This keeps cold catalogs/search near-instant.
      const cats = limitedCategoryList(await fetchAllCategories(config), config)
        .filter((c) => c.type === xtType);
      if (!cats.length) {
        // Categories unavailable (endpoint failure) — fall back to the full
        // fetch so the addon still has content.
        return staleWhileRevalidate(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
          const client = new XtreamClient(config.host!, config.username!, config.password!);
          return client.getStreams(xtType);
        }, { secrets });
      }
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      const groups: IPTVItem[][] = [];
      // Bounded concurrency so a large limit never hammers the panel.
      for (let i = 0; i < cats.length; i += CATEGORY_FETCH_CONCURRENCY) {
        const batch = cats.slice(i, i + CATEGORY_FETCH_CONCURRENCY);
        const results = await Promise.all(batch.map((cat) =>
          staleWhileRevalidate(`xt:streams:${fp}:${xtType}:cat_${cat.id}`, TTL.STREAMS, () =>
            client.getStreams(xtType, cat.id), { secrets })
        ));
        groups.push(...results);
      }
      return groups.flat();
    }
    return staleWhileRevalidate(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getStreams(xtType);
    }, { secrets });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await fetchParsedM3U(config);
    const kindItems = parsed.items.filter((item) => item.type === kind);
    if (!categoryLimit(config)) return kindItems;
    // Only the limited categories' items (the playlist file itself must still
    // be downloaded+parsed once, but everything downstream is small). If the
    // category list is unavailable, show everything rather than nothing.
    const limited = limitedCategoryList(parsed.categories, config);
    if (!limited.length) return kindItems;
    const allowed = new Set(limited.map((c) => c.id));
    return kindItems.filter((i) => allowed.has(i.categoryId || ''));
  }

  return [];
}

export async function getAllCategories(config: UserConfig): Promise<IPTVCategory[]> {
  return limitedCategoryList(await fetchAllCategories(config), config);
}

/**
 * Pre-fetch everything the addon needs for a config so the FIRST user never
 * waits on a cold cache. Results land under the same fingerprint keys the
 * addon reads. Best effort — callers fire it without awaiting (configure
 * time, manifest loads); failures just mean the normal path warms instead.
 */
export async function warmProviderCache(config: UserConfig): Promise<void> {
  try {
    if (config.type === 'xtream' && config.host && config.username && config.password) {
      await Promise.allSettled([
        fetchAllCategories(config),
        getItems(config, 'channel'),
        getItems(config, 'movie'),
        getItems(config, 'series')
      ]);
    } else if (config.type === 'm3u' && config.m3uUrl) {
      // One cached parse covers items AND categories for M3U.
      await Promise.allSettled([fetchParsedM3U(config)]);
    }
  } catch (err) {
    console.error('Cache warm-up failed (non-fatal):', err);
  }
}

export async function getTitleMatches(
  config: UserConfig,
  kind: Exclude<MediaKind, 'channel'>,
  titles: string[]
): Promise<IPTVItem[]> {
  const fp = configFingerprint(config);
  const items = await getItems(config, kind);
  // Not JSON-serializable and trivially rebuilt from the shared stream list,
  // so this index stays per-instance and is never written to Redis.
  const index = await cached<TitleIndex>(`title-index:${fp}:${kind}`, TTL.STREAMS, async () => {
    const map: TitleIndex = new Map();
    for (const item of items) {
      const key = titleIdentity(item.title);
      if (!key) continue;
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, { shared: false });

  const matches: IPTVItem[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const key = titleIdentity(title);
    for (const item of index.get(key) || []) {
      const identity = String(item.streamId ?? item.url ?? item.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push(item);
    }
  }
  return matches;
}
