"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeForMatch = normalizeForMatch;
exports.matchScore = matchScore;
exports.rankMatches = rankMatches;
exports.itemsToStreams = itemsToStreams;
exports.filterAndSortMatchingStreams = filterAndSortMatchingStreams;
const string_similarity_1 = __importDefault(require("string-similarity"));
const cleaner_1 = require("../iptv/cleaner");
/**
 * Aggressively normalize a title for comparison:
 * - lowercase, strip accents
 * - drop leading articles (the/a/an/le/la/el/il...)
 * - remove punctuation, collapse whitespace
 * - normalize roman numerals and "&"/"and"
 */
function normalizeForMatch(input) {
    if (!input)
        return '';
    let s = (0, cleaner_1.cleanTitle)(input).cleanTitle.toLowerCase();
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
function identityTokens(input) {
    return (0, cleaner_1.titleIdentity)(input).split(' ').filter(Boolean);
}
/** True when the provider title has the same identity words as the target.
 * Release metadata and quality variants are intentionally ignored. */
function isExactIdentity(target, candidate) {
    const targetTokens = identityTokens(target);
    const candidateTokens = identityTokens(candidate);
    if (!targetTokens.length || targetTokens.length !== candidateTokens.length)
        return false;
    return targetTokens.every((token, index) => token === candidateTokens[index]);
}
function matchScore(targetTitle, streamTitle, targetYear) {
    const t = normalizeForMatch(targetTitle);
    const s = normalizeForMatch(streamTitle);
    if (!t || !s)
        return 0;
    // Exact normalized match is the gold standard
    if (t === s) {
        const sy = (0, cleaner_1.cleanTitle)(streamTitle).year;
        if (targetYear && sy && Math.abs(targetYear - sy) > 1)
            return 0.7;
        return 1.0;
    }
    const base = string_similarity_1.default.compareTwoStrings(t, s);
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
    const sy = (0, cleaner_1.cleanTitle)(streamTitle).year;
    if (targetYear && sy) {
        if (Math.abs(targetYear - sy) <= 1)
            score += 0.06;
        else if (Math.abs(targetYear - sy) <= 3)
            score -= 0.1; // close but off
        else
            score -= 0.2; // wrong decade → likely different title
    }
    return Math.max(0, Math.min(1, score));
}
/**
 * Rank IPTV items against a target title (plus optional alternative titles).
 * Returns the matching items with their score so callers can build streams or
 * resolve episodes.
 */
function rankMatches(targetTitle, streams, opts = {}) {
    const { targetYear, targetSeason, targetEpisode, altTitles = [], minScore = 0.62 } = opts;
    const titles = [targetTitle, ...altTitles].filter(Boolean);
    const matches = [];
    for (const stream of streams) {
        // For flat episode entries (M3U), skip clearly mismatched episodes
        if (targetSeason !== undefined && targetEpisode !== undefined) {
            const parsed = (0, cleaner_1.cleanTitle)(stream.title);
            if (parsed.season !== undefined && parsed.episode !== undefined) {
                if (parsed.season !== targetSeason || parsed.episode !== targetEpisode)
                    continue;
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
            if (sc > best)
                best = sc;
            if (best >= 0.99)
                break;
        }
        if (best >= minScore && titles.some((title) => isExactIdentity(title, stream.title))) {
            matches.push({ item: stream, score: best });
        }
    }
    matches.sort((a, b) => b.score - a.score);
    // De-duplicate by normalized title + resolved URL so we don't list the same
    // source many times, and drop anything far below the top match.
    const seen = new Set();
    const deduped = [];
    const topScore = matches.length ? matches[0].score : 0;
    for (const m of matches) {
        if (m.score < topScore - 0.2)
            break; // keep only near-best matches
        const key = `${(0, cleaner_1.titleIdentity)(m.item.title)}|${m.item.url || m.item.streamId || ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(m);
        if (deduped.length >= 8)
            break;
    }
    return deduped;
}
function itemsToStreams(matches) {
    return matches
        .filter((m) => m.item.url)
        .map(({ item }) => {
        const parsed = (0, cleaner_1.cleanTitle)(item.title);
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
function filterAndSortMatchingStreams(targetTitle, streams, targetYear, targetSeason, targetEpisode, minScore = 0.5) {
    const matches = rankMatches(targetTitle, streams, {
        targetYear,
        targetSeason,
        targetEpisode,
        minScore
    });
    return itemsToStreams(matches);
}
