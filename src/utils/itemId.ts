import { IPTVItem } from '../types';

/**
 * Compact, URL/Stremio-safe identity for an IPTV catalog item.
 *
 * Stremio splits ids on ':' for series video ids (`<metaId>:<season>:<episode>`),
 * so the encoded blob uses base64url which never contains ':'. That keeps our
 * ids stable while allowing season/episode suffixes to be appended safely.
 *
 * Encoded form:  iptv:<base64url(JSON)>
 * Series video:  iptv:<base64url(JSON)>:<season>:<episode>
 */
export interface ItemRef {
  k: 'channel' | 'movie' | 'series';
  t: string;            // title
  y?: number;           // year
  u?: string;           // direct url (movie/live)
  sid?: string | number; // xtream stream/series id
  lg?: string;          // logo
  ci?: string;          // container extension
}

const PREFIX = 'iptv:';

function toBase64Url(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(b64: string): string {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

export function encodeItemId(item: IPTVItem): string {
  const ref: ItemRef = {
    k: item.type,
    t: item.title,
    y: item.year,
    u: item.url || undefined,
    sid: item.streamId,
    lg: item.logo,
    ci: item.containerExtension
  };
  return PREFIX + toBase64Url(JSON.stringify(ref));
}

export interface DecodedId {
  ref: ItemRef | null;
  season?: number;
  episode?: number;
}

export function decodeItemId(id: string): DecodedId {
  if (!id.startsWith(PREFIX)) return { ref: null };
  const rest = id.slice(PREFIX.length);
  const parts = rest.split(':'); // [blob, season?, episode?]
  const blob = parts[0];
  let season: number | undefined;
  let episode: number | undefined;
  if (parts.length >= 3) {
    season = parseInt(parts[parts.length - 2], 10);
    episode = parseInt(parts[parts.length - 1], 10);
  }
  try {
    const ref = JSON.parse(fromBase64Url(blob)) as ItemRef;
    return { ref, season, episode };
  } catch {
    return { ref: null, season, episode };
  }
}

export function isItemId(id: string): boolean {
  return id.startsWith(PREFIX);
}
