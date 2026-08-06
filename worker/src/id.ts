// Compact, URL/Stremio-safe identity for a provider catalog item.
//
// M3U items have no stable numeric id, so we embed the essentials (title, url,
// year, xtream id, logo, container ext) as a base64url JSON blob. base64url
// never contains ':', so Stremio can append `:<season>:<episode>` for series
// video ids without ambiguity.
//
//   Encoded form:  iptv:<base64url(JSON)>
//   Series video:  iptv:<base64url(JSON)>:<season>:<episode>

import { ProviderItem } from './types';

const PREFIX = 'iptv:';

export interface ItemRef {
  k: 'channel' | 'movie' | 'series';
  t: string; // title
  y?: number; // year
  u?: string; // direct url (movie/live)
  sid?: string | number; // xtream stream/series id
  lg?: string; // logo
  ci?: string; // container extension
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64: string): string {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(normalized);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeItemId(item: ProviderItem): string {
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
