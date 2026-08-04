import stringSimilarity from 'string-similarity';
import { IPTVItem, StremioStream } from '../types';
import { cleanTitle } from '../iptv/cleaner';

/**
 * Aggressively normalize a title for comparison:
 * - lowercase, strip accents
 * - drop leading articles (the/a/an/le/la/el/il...)
 * - remove punctuation, collapse whitespace
 * - normalize roman numerals and "&"/"and"
 */
export function normalizeForMatch(input: string): string {
  if (!input) return '';
  let s = cleanTitle(input).cleanTitle.toLowerCase();

  // strip accents/diacritics
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // unify ampersand
  s = s.replace(/&/g, ' and ');

  // remove apostrophes entirely (don't -> dont), other punctuation -> space
  s = s.replace(/['’`]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');

  // drop leading articles in several languages
  s = s.replace(/^(the|a|an|le|la|les|el|los|las|il|lo|un|una|der|die|das)\s+/i, '');

  return s.replace(/\s+/g, ' ').trim();
}

export function matchScore(targetTitle: string, streamTitle: string, targetYear?: number): number {
  const t = normalizeForMatch(targetTitle);
  const s = normalizeForMatch(streamTitle);
  if (!t || !s) return 0;

  if (t === s) return 1.0;

  let score = stringSimilarity.compareTwoStrings(t, s);

  // Containment bonus (stream titles often carry extra words: "Movie 2021 MULTI")
  if (s.includes(t) || t.includes(s)) {
    const shorter = Math.min(t.length, s.length);
    const longer = Math.max(t.length, s.length);
    // reward strong containment, but not tiny fragments
    score = Math.max(score, 0.7 + 0.25 * (shorter / longer));
  }

  // Token overlap (helps word-order differences)
  const tTokens = new Set(t.split(' '));
  const sTokens = new Set(s.split(' '));
  const overlap = [...tTokens].filter((w) => sTokens.has(w)).length;
  const tokenScore = overlap / Math.max(tTokens.size, 1);
  score = Math.max(score, tokenScore * 0.9);

  // Year handling
  const streamYear = cleanTitle(streamTitle).year;
  if (targetYear && streamYear) {
    if (Math.abs(targetYear - streamYear) <= 1) score = Math.min(1, score + 0.08);
    else if (Math.abs(targetYear - streamYear) > 2) score *= 0.7;
  }

  return score;
}

export interface MatchOptions {
  targetYear?: number;
  targetSeason?: number;
  targetEpisode?: number;
  altTitles?: string[];
  minScore?: number;
}

/**
 * Rank IPTV items against a target title (plus optional alternative titles).
 * Returns the matching items with their score so callers can build streams or
 * resolve episodes.
 */
export function rankMatches(
  targetTitle: string,
  streams: IPTVItem[],
  opts: MatchOptions = {}
): Array<{ item: IPTVItem; score: number }> {
  const { targetYear, targetSeason, targetEpisode, altTitles = [], minScore = 0.5 } = opts;
  const titles = [targetTitle, ...altTitles].filter(Boolean);

  const matches: Array<{ item: IPTVItem; score: number }> = [];

  for (const stream of streams) {
    // For flat episode entries (M3U), skip clearly mismatched episodes
    if (targetSeason !== undefined && targetEpisode !== undefined) {
      const parsed = cleanTitle(stream.title);
      if (parsed.season !== undefined && parsed.episode !== undefined) {
        if (parsed.season !== targetSeason || parsed.episode !== targetEpisode) continue;
      }
    }

    let best = 0;
    for (const title of titles) {
      const sc = matchScore(title, stream.title, targetYear);
      if (sc > best) best = sc;
      if (best >= 0.99) break;
    }

    if (best >= minScore) matches.push({ item: stream, score: best });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

export function itemsToStreams(matches: Array<{ item: IPTVItem; score: number }>): StremioStream[] {
  return matches
    .filter((m) => m.item.url)
    .map(({ item }) => {
      const parsed = cleanTitle(item.title);
      const quality = parsed.quality || '';
      const catStr = item.category ? ` • ${item.category}` : '';
      return {
        name: `🎬 IPTV${quality ? ' ' + quality : ''}`,
        title: `${item.title}${catStr}`,
        url: item.url || '',
        quality: quality || undefined
      };
    });
}

// Backwards-compatible helper
export function filterAndSortMatchingStreams(
  targetTitle: string,
  streams: IPTVItem[],
  targetYear?: number,
  targetSeason?: number,
  targetEpisode?: number,
  minScore: number = 0.5
): StremioStream[] {
  const matches = rankMatches(targetTitle, streams, {
    targetYear,
    targetSeason,
    targetEpisode,
    minScore
  });
  return itemsToStreams(matches);
}
