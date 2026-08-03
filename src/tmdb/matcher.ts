import stringSimilarity from 'string-similarity';
import { IPTVItem, StremioStream } from '../types';
import { cleanTitle } from '../iptv/cleaner';

export function matchStreamTitle(targetTitle: string, streamTitle: string, targetYear?: number): number {
  const cleanTarget = cleanTitle(targetTitle).cleanTitle.toLowerCase();
  const cleanStream = cleanTitle(streamTitle).cleanTitle.toLowerCase();

  if (!cleanTarget || !cleanStream) return 0;

  // Exact match
  if (cleanTarget === cleanStream) return 1.0;

  // String similarity score
  let score = stringSimilarity.compareTwoStrings(cleanTarget, cleanStream);

  // Bonus if target title is contained inside stream title
  if (cleanStream.includes(cleanTarget)) {
    score = Math.max(score, 0.85);
  }

  // Penalty if years are present and differ
  const streamYear = cleanTitle(streamTitle).year;
  if (targetYear && streamYear && Math.abs(targetYear - streamYear) > 1) {
    score *= 0.5;
  }

  return score;
}

export function filterAndSortMatchingStreams(
  targetTitle: string,
  streams: IPTVItem[],
  targetYear?: number,
  targetSeason?: number,
  targetEpisode?: number,
  minScore: number = 0.55
): StremioStream[] {
  const matches: Array<{ item: IPTVItem; score: number }> = [];

  for (const stream of streams) {
    // If series episode request, verify season and episode match
    if (targetSeason !== undefined && targetEpisode !== undefined) {
      const parsed = cleanTitle(stream.title);
      if (parsed.season !== undefined && parsed.episode !== undefined) {
        if (parsed.season !== targetSeason || parsed.episode !== targetEpisode) {
          continue; // Skip mismatched episode
        }
      }
    }

    const score = matchStreamTitle(targetTitle, stream.title, targetYear);
    if (score >= minScore) {
      matches.push({ item: stream, score });
    }
  }

  // Sort descending by score
  matches.sort((a, b) => b.score - a.score);

  // Format into StremioStream
  return matches.map(({ item }) => {
    const parsed = cleanTitle(item.title);
    const qualityStr = parsed.quality ? ` [${parsed.quality}]` : '';
    const catStr = item.category ? ` • ${item.category}` : '';

    return {
      name: `IPTV${qualityStr}`,
      title: `${item.title}${catStr}`,
      url: item.url || ''
    };
  });
}
