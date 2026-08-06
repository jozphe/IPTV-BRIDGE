// Fuzzy title matching, ported from the Node matcher, self-contained (Dice
// coefficient inlined so there is no `string-similarity` dependency).

import { cleanTitle, titleIdentity } from './cleaner';
import { ProviderItem, StremioStream } from './types';

/** Sorensen–Dice coefficient over character bigrams (0..1). */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substring(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.substring(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

export function normalizeForMatch(input: string): string {
  if (!input) return '';
  let s = cleanTitle(input).cleanTitle.toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['\u2019`]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/^(the|a|an|le|la|les|el|los|las|il|lo|un|una|der|die|das)\s+/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

function identityTokens(input: string): string[] {
  return titleIdentity(input).split(' ').filter(Boolean);
}

function isExactIdentity(target: string, candidate: string): boolean {
  const t = identityTokens(target);
  const c = identityTokens(candidate);
  if (!t.length || t.length !== c.length) return false;
  return t.every((tok, i) => tok === c[i]);
}

export function matchScore(targetTitle: string, streamTitle: string, targetYear?: number): number {
  const t = normalizeForMatch(targetTitle);
  const s = normalizeForMatch(streamTitle);
  if (!t || !s) return 0;

  if (t === s) {
    const sy = cleanTitle(streamTitle).year;
    if (targetYear && sy && Math.abs(targetYear - sy) > 1) return 0.7;
    return 1.0;
  }

  const base = diceCoefficient(t, s);
  const tTokens = t.split(' ').filter(Boolean);
  const sTokens = s.split(' ').filter(Boolean);
  const tSet = new Set(tTokens);
  const sSet = new Set(sTokens);

  const missing = tTokens.filter((w) => !sSet.has(w)).length;
  const extra = sTokens.filter((w) => !tSet.has(w)).length;

  if (missing > 1) return Math.min(base, 0.5);
  if (missing === 1 && base < 0.85) return Math.min(base, 0.55);

  const bigExtra = sTokens.filter((w) => !tSet.has(w) && w.length >= 3 && !/^\d+$/.test(w)).length;
  let score = 0.9 - bigExtra * 0.16 - Math.max(0, extra - bigExtra) * 0.03;
  score = Math.max(score, base);

  const sy = cleanTitle(streamTitle).year;
  if (targetYear && sy) {
    if (Math.abs(targetYear - sy) <= 1) score += 0.06;
    else if (Math.abs(targetYear - sy) <= 3) score -= 0.1;
    else score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

export interface MatchOptions {
  targetYear?: number;
  targetSeason?: number;
  targetEpisode?: number;
  altTitles?: string[];
  minScore?: number;
}

export function rankMatches(
  targetTitle: string,
  streams: ProviderItem[],
  opts: MatchOptions = {}
): Array<{ item: ProviderItem; score: number }> {
  const { targetYear, targetSeason, targetEpisode, altTitles = [], minScore = 0.62 } = opts;
  const titles = [targetTitle, ...altTitles].filter(Boolean);

  const matches: Array<{ item: ProviderItem; score: number }> = [];
  for (const stream of streams) {
    if (targetSeason !== undefined && targetEpisode !== undefined) {
      const parsed = cleanTitle(stream.title);
      if (parsed.season !== undefined && parsed.episode !== undefined) {
        if (parsed.season !== targetSeason || parsed.episode !== targetEpisode) continue;
      }
    }

    let best = 0;
    for (const title of titles) {
      if (isExactIdentity(title, stream.title)) {
        best = Math.max(best, 1);
        continue;
      }
      const sc = matchScore(title, stream.title, targetYear);
      if (sc > best) best = sc;
      if (best >= 0.99) break;
    }

    if (best >= minScore && titles.some((title) => isExactIdentity(title, stream.title))) {
      matches.push({ item: stream, score: best });
    }
  }

  matches.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const deduped: Array<{ item: ProviderItem; score: number }> = [];
  const topScore = matches.length ? matches[0].score : 0;
  for (const m of matches) {
    if (m.score < topScore - 0.2) break;
    const key = `${titleIdentity(m.item.title)}|${m.item.url || m.item.streamId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

export function itemsToStreams(matches: Array<{ item: ProviderItem; score: number }>): StremioStream[] {
  return matches
    .filter((m) => m.item.url)
    .map(({ item }) => {
      const parsed = cleanTitle(item.title);
      const quality = parsed.quality || '';
      const catStr = item.category ? ` \u2022 ${item.category}` : '';
      return {
        name: `IPTV${quality ? ' ' + quality : ''}`,
        title: `${item.title}${catStr}`,
        url: item.url || '',
        quality: quality || undefined
      };
    });
}
