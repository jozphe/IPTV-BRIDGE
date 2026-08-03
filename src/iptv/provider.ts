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
      parseM3UPlaylist(config.m3uUrl!, config.includedCategories)
    );
    return parsed.items.filter((item) => item.type === kind);
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
      parseM3UPlaylist(config.m3uUrl!, config.includedCategories)
    );
    return parsed.categories;
  }

  return [];
}
