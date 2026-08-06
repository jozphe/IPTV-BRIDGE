import { UserConfig, IPTVItem, IPTVCategory } from '../types';
import { XtreamClient } from './xtream';
import { parseM3UPlaylist, ParsedM3U } from './m3u';
import { cached, staleWhileRevalidate, TTL, secretsFromConfig } from '../utils/cache';
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
/**
 * Apply the configurator's category selection to a full item/category list.
 * If the selection matches NOTHING (e.g. the playlist was replaced or renamed
 * its groups since the manifest link was created), it is treated as stale and
 * the full list is returned instead of an empty/trimmed catalog.
 */
function applySelection<T>(
  list: T[],
  selected: ((id: string | undefined, name: string) => boolean) | null,
  getId: (item: T) => string | undefined,
  getName: (item: T) => string
): T[] {
  if (!selected || !list.length) return list;
  const filtered = list.filter((item) => selected(getId(item), getName(item)));
  return filtered.length ? filtered : list;
}

/**
 * Fetch the provider's FULL category list (no selection applied, never
 * trimmed). Used to decide whether a selection is stale provider-wide.
 */
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

/**
 * Staleness gate (pure): a selection is "stale" only when it matches NO
 * category in the provider's full category list (playlist replaced/renamed
 * since the link was created). Partial matches are respected strictly —
 * deliberately deselected types must not be flooded back in. An empty
 * category list can't prove staleness, so it is treated as "not stale"
 * (strict filtering) rather than guessing.
 */
function selectionIsStale(
  selected: ((id: string | undefined, name: string) => boolean) | null,
  all: IPTVCategory[]
): boolean {
  if (!selected || !all.length) return false;
  return !all.some((cat) => selected(cat.id, cat.name));
}

export async function getItems(config: UserConfig, kind: MediaKind): Promise<IPTVItem[]> {
  const fp = configFingerprint(config);
  const selected = buildCategoryMatcher(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    const xtType = kind === 'channel' ? 'live' : kind;
    // The matcher must run AFTER the cached fetch: the cache key only covers
    // credentials, so filtering inside the producer would serve one user's
    // category selection to every other user sharing the same provider.
    // The staleness check needs the full category list; fetch it in parallel
    // so a cold cache costs max(streams, cats) instead of their sum.
    const itemsP = staleWhileRevalidate(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getStreams(xtType);
    }, { secrets: secretsFromConfig(config) });
    const catsP = selected
      ? fetchAllCategories(config).catch((err) => {
          // Can't judge staleness — fall back to strict filtering.
          console.error('Category staleness check failed:', err);
          return [] as IPTVCategory[];
        })
      : Promise.resolve([] as IPTVCategory[]);
    const [items, allCats] = await Promise.all([itemsP, catsP]);

    if (!selected) return items;
    if (selectionIsStale(selected, allCats)) return items; // entirely stale selection
    return items.filter((i) => selected(i.categoryId, i.category)); // strict per-kind
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    // Parse the complete source once. Category filtering belongs after the
    // parse, otherwise a cache entry created for one selection can poison a
    // later request with a different category selection.
    const parsed = await fetchParsedM3U(config);
    const kindItems = parsed.items.filter((item) => item.type === kind);
    if (!selected) return kindItems;
    if (selectionIsStale(selected, parsed.categories)) return kindItems; // entirely stale selection
    return kindItems.filter((i) => selected(i.categoryId, i.category)); // strict per-kind
  }

  return [];
}

export async function getCategories(config: UserConfig): Promise<IPTVCategory[]> {
  const selected = buildCategoryMatcher(config);
  const all = await fetchAllCategories(config);
  // The input here is the FULL list, so a zero-match fallback is exactly the
  // whole-provider staleness case (playlist replaced) — deliberate per-type
  // deselection can't be misread because the full list has matches elsewhere.
  return applySelection(all, selected, (c) => c.id, (c) => c.name);
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
