import { UserConfig, IPTVItem, IPTVCategory } from '../types';
import { XtreamClient } from './xtream';
import { parseM3UPlaylist } from './m3u';
import { cached, TTL } from '../utils/cache';
import crypto from 'crypto';

export type MediaKind = 'channel' | 'movie' | 'series';

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
    return cached(`xt:streams:${fp}:${xtType}`, TTL.STREAMS, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getStreams(xtType);
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await cached(`m3u:parsed:${fp}`, TTL.PLAYLIST, () =>
      // Parse the complete source once. Category filtering belongs after the
      // parse, otherwise a cache entry created for one selection can poison a
      // later request with a different category selection.
      parseM3UPlaylist(config.m3uUrl!)
    );
    const selected = config.includedCategories?.length
      ? new Set(config.includedCategories.map(String))
      : null;
    return parsed.items.filter((item) =>
      item.type === kind &&
      (!selected || selected.has(item.category) || selected.has(item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')))
    );
  }

  return [];
}

export async function getCategories(config: UserConfig): Promise<IPTVCategory[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return cached(`xt:cats:${fp}`, TTL.CATEGORIES, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      return client.getCategories();
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await cached(`m3u:parsed:${fp}`, TTL.PLAYLIST, () =>
      parseM3UPlaylist(config.m3uUrl!)
    );
    if (!config.includedCategories?.length) return parsed.categories;
    const selected = new Set(config.includedCategories.map(String));
    return parsed.categories.filter((category) => selected.has(category.id) || selected.has(category.name));
  }

  return [];
}
