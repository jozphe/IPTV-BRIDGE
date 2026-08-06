import { UserConfig, IPTVItem, IPTVCategory } from '../types';
import { XtreamClient } from './xtream';
import { parseM3UPlaylist } from './m3u';
import { cached, staleWhileRevalidate, TTL } from '../utils/cache';
import crypto from 'crypto';
import { titleIdentity, categorySlug } from './cleaner';

export type MediaKind = 'channel' | 'movie' | 'series';
type TitleIndex = Map<string, IPTVItem[]>;

/**
 * Build a matcher honoring the configurator's category selection.
 * `includedCategories` stores category ids (Xtream `live_5` / `vod_45`,
 * M3U name-slugs) but items only expose the category NAME, so we match on
 * id OR name OR slugified name to cover every provider shape.
 */
function buildCategoryMatcher(
  config: UserConfig
): ((id: string | undefined, name: string) => boolean) | null {
  const selected = config.includedCategories;
  if (!selected || !selected.length) return null;
  const ids = new Set(selected.map(String));
  const slugs = new Set(selected.map((s) => categorySlug(String(s))));
  return (id, name) => {
    const idStr = id ? String(id) : '';
    return ids.has(idStr) || ids.has(name) || slugs.has(categorySlug(idStr)) || slugs.has(categorySlug(name));
  };
}

function configFingerprint(config: UserConfig): string {
  const raw = config.type === 'xtream'
    ? `xt|${config.host}|${config.username}|${config.password}`
    : `m3u|${config.m3uUrl}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * Fetch every IPTV item for a given media kind, cached per-provider.
 * Xtream fetches only the relevant type; M3U parses once and is reused across
 * all kinds via a single cached parse.
 */
export async function getItems(config: UserConfig, kind: MediaKind): Promise<IPTVItem[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    const xtType = kind === 'channel' ? 'live' : kind;
    const selected = buildCategoryMatcher(config);
    // The matcher must run AFTER the cached fetch: the cache key only covers
    // credentials, so filtering inside the producer would serve one user's
    // category selection to every other user sharing the same provider.
    const items = await staleWhileRevalidate(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getStreams(xtType);
    });
    return selected ? items.filter((item) => selected(item.categoryId, item.category)) : items;
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await staleWhileRevalidate(`m3u:parsed:${fp}`, TTL.PLAYLIST, () =>
      // Parse the complete source once. Category filtering belongs after the
      // parse, otherwise a cache entry created for one selection can poison a
      // later request with a different category selection.
      parseM3UPlaylist(config.m3uUrl!)
    );
    const selected = buildCategoryMatcher(config);
    return parsed.items.filter((item) =>
      item.type === kind &&
      (!selected || selected(item.categoryId, item.category))
    );
  }

  return [];
}

export async function getCategories(config: UserConfig): Promise<IPTVCategory[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    const selected = buildCategoryMatcher(config);
    const categories = await staleWhileRevalidate(`xt:cats:${fp}`, TTL.CATEGORIES, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getCategories();
    });
    return selected ? categories.filter((category) => selected(category.id, category.name)) : categories;
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await staleWhileRevalidate(`m3u:parsed:${fp}`, TTL.PLAYLIST, () =>
      parseM3UPlaylist(config.m3uUrl!)
    );
    const selected = buildCategoryMatcher(config);
    return selected ? parsed.categories.filter((category) => selected(category.id, category.name)) : parsed.categories;
  }

  return [];
}

export async function getTitleMatches(
  config: UserConfig,
  kind: Exclude<MediaKind, 'channel'>,
  titles: string[]
): Promise<IPTVItem[]> {
  const fp = configFingerprint(config);
  const items = await getItems(config, kind);
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
  });

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
