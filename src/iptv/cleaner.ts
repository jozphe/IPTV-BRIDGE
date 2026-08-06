export interface CleanedTitle {
  original: string;
  cleanTitle: string;
  year?: number;
  season?: number;
  episode?: number;
  quality?: string;
  language?: string;
  country?: string;
}

/** Normalize only title identity, retaining words that can distinguish a
 * sequel/subtitle while removing provider release metadata. */
export function titleIdentity(rawTitle: string): string {
  const parsed = cleanTitle(rawTitle);
  return parsed.cleanTitle
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an|le|la|les|el|los|las|il|lo|un|una|der|die|das)\s+/, '');
}

export function cleanTitle(rawTitle: string): CleanedTitle {
  if (!rawTitle) {
    return { original: '', cleanTitle: '' };
  }

  let title = rawTitle.trim();

  // Extract Season & Episode (S01E02, S1 E2, 1x02, Season 1 Ep 2)
  let season: number | undefined;
  let episode: number | undefined;

  const seMatch = title.match(/(?:S|Season\s*)(\d{1,2})\s*(?:E|Ep|Episode\s*|x|\-)\s*(\d{1,3})/i) ||
                  title.match(/(\d{1,2})x(\d{1,3})/i);
  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
  }

  // Extract Year (19xx or 20xx)
  let year: number | undefined;
  const yearMatch = title.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  // Extract Quality
  let quality: string | undefined;
  if (/4K|UHD|2160p/i.test(title)) quality = '4K UHD';
  else if (/1080p|FHD/i.test(title)) quality = '1080p';
  else if (/720p|HD/i.test(title)) quality = '720p';
  else if (/SD|480p/i.test(title)) quality = 'SD';

  // Clean title text
  let cleaned = title;

  // Remove common prefixes like "US:", "UK |", "IN -", "FR -", "CA |", "[EN]", "[US]"
  cleaned = cleaned.replace(/^[A-Z]{2,4}\s*[:\|\-]\s*/i, '');
  cleaned = cleaned.replace(/^\[[A-Z]{2,4}\]\s*/i, '');

  // Remove release metadata while preserving real title/subtitle words.
  const releaseTag = '(?:4K|UHD|2160p|1080p|720p|480p|FHD|HD|SD|HEVC|H\\.?265|H\\.?264|x265|x264|RAW|WEB[ .-]?DL|WEBRip|BluRay|BRRip|DVDRip|HDR10?|Dolby|Atmos|AAC|AC3|DTS|MULTI|MULTiSUB|Dual[ .-]?Audio)';
  cleaned = cleaned.replace(new RegExp(`\\[\\s*${releaseTag}\\s*\\]`, 'gi'), '');
  cleaned = cleaned.replace(new RegExp(`\\b${releaseTag}\\b`, 'gi'), '');

  // Standalone language/provider tags are metadata, not title identity.
  cleaned = cleaned.replace(/\b(?:EN|ENG|English|FR|FRE|French|ES|SPA|Spanish|DE|GER|German|IT|ITA|Italian|PT|POR|Portuguese|HI|HIN|Hindi|AR|ARA|Arabic|TR|TUR|Turkish)\b/gi, '');

  // Remove S01E02 patterns
  cleaned = cleaned.replace(/(?:S|Season\s*)(\d{1,2})\s*(?:E|Ep|Episode\s*|x|\-)\s*(\d{1,3})/gi, '');
  cleaned = cleaned.replace(/(\d{1,2})x(\d{1,3})/gi, '');

  // Remove Year
  if (year) {
    cleaned = cleaned.replace(new RegExp(`\\b${year}\\b`, 'g'), '');
  }

  // Remove brackets and parentheses leftovers
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)/g, '');

  // Replace dots, underscores, dashes with space
  cleaned = cleaned.replace(/[\._\-]+/g, ' ');

  // Clean extra white spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return {
    original: rawTitle,
    cleanTitle: cleaned || rawTitle,
    year,
    season,
    episode,
    quality
  };
}
