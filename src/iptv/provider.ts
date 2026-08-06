import { UserConfig, IPTVItem, IPTVCategory } from '../types';
import { XtreamClient } from './xtream';
import { parseM3UPlaylist, ParsedM3U } from './m3u';
import { cached, staleWhileRevalidate, TTL, secretsFromConfig } from '../utils/cache';
import crypto from 'crypto';
import { titleIdentity } from './cleaner';

export type MediaKind = 'channel' | 'movie' | 'series';
type TitleIndex = Map<string, IPTVItem[]>;

function configFingerprint(config: UserConfig): string {
  const raw = config.type === 'xtream'
    ? `xt|${config.host}|${config.username}|${config.password}`
    : `m3u|${config.m3uUrl}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
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

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    const xtType = kind === 'channel' ? 'live' : kind;
    return staleWhileRevalidate(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getStreams(xtType);
    }, { secrets: secretsFromConfig(config) });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await fetchParsedM3U(config);
    return parsed.items.filter((item) => item.type === kind);
  }

  return [];
}

export async function getAllCategories(config: UserConfig): Promise<IPTVCategory[]> {
  return fetchAllCategories(config);
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
