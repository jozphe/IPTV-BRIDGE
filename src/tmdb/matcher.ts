import stringSimilarity from 'string-similarity';
import { IPTVItem, StremioStream } from '../types';
import { cleanTitle, titleIdentity } from '../iptv/cleaner';

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

function identityTokens(input: string): string[] {
  return titleIdentity(input).split(' ').filter(Boolean);
}

/** True when the provider title has the same identity words as the target.
 * Release metadata and quality variants are intentionally ignored. */
function isExactIdentity(target: string, candidate: string): boolean {
  const targetTokens = identityTokens(target);
  const candidateTokens = identityTokens(candidate);
  if (!targetTokens.length || targetTokens.length !== candidateTokens.length) return false;
  return targetTokens.every((token, index) => token === candidateTokens[index]);
}

export function matchScore(targetTitle: string, streamTitle: string, targetYear?: number): number {
  const t = normalizeForMatch(targetTitle);
  const s = normalizeForMatch(streamTitle);
  if (!t || !s) return 0;

  // Exact normalized match is the gold standard
  if (t === s) {
    const sy = cleanTitle(streamTitle).year;
    if (targetYear && sy && Math.abs(targetYear - sy) > 1) return 0.7;
    return 1.0;
  }

  const base = stringSimilarity.compareTwoStrings(t, s);

  const tTokens = t.split(' ').filter(Boolean);
  const sTokens = s.split(' ').filter(Boolean);
  const tSet = new Set(tTokens);
  const sSet = new Set(sTokens);

  // Check if target words are in the stream. IPTV titles always carry extra
  // metadata (quality, language codes, year), so we can't require perfection.
  const missing = tTokens.filter((w) => !sSet.has(w)).length;
  const extra = sTokens.filter((w) => !tSet.has(w)).length;

  // If too many target words are missing, it's likely a different title
  if (missing > 1) {
    return Math.min(base, 0.5);
  }
  // One missing word: only allow if base similarity is high
  if (missing === 1 && base < 0.85) {
    return Math.min(base, 0.55);
  }

  // All (or nearly all) target tokens present. Penalize extra *significant*
  // words (3+ chars) more than tiny tags, since a real extra word usually
  // signals a different title (e.g. "Dune Part Two" vs "Dune").
  const bigExtra = sTokens.filter((w) => !tSet.has(w) && w.length >= 3 && !/^\d+$/.test(w)).length;
  let score = 0.9 - bigExtra * 0.16 - Math.max(0, extra - bigExtra) * 0.03;
  score = Math.max(score, base);

  // Year alignment rewards/penalizes, but less aggressively
  const sy = cleanTitle(streamTitle).year;
  if (targetYear && sy) {
    if (Math.abs(targetYear - sy) <= 1) score += 0.06;
    else if (Math.abs(targetYear - sy) <= 3) score -= 0.1; // close but off
    else score -= 0.2; // wrong decade → likely different title
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
  const { targetYear, targetSeason, targetEpisode, altTitles = [], minScore = 0.62 } = opts;
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
      // A provider title with extra identity words is a different title. This
      // preserves FHD/4K/language variants because those are removed by
      // titleIdentity, while rejecting sequels and subtitles.
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

  // De-duplicate by normalized title + resolved URL so we don't list the same
  // source many times, and drop anything far below the top match.
  const seen = new Set<string>();
  const deduped: Array<{ item: IPTVItem; score: number }> = [];
  const topScore = matches.length ? matches[0].score : 0;

  for (const m of matches) {
    if (m.score < topScore - 0.2) break; // keep only near-best matches
    const key = `${titleIdentity(m.item.title)}|${m.item.url || m.item.streamId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
    if (deduped.length >= 8) break;
  }

  return deduped;
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
