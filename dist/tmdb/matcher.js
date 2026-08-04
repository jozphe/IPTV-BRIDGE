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
function matchScore(targetTitle, streamTitle, targetYear) {
    const t = normalizeForMatch(targetTitle);
    const s = normalizeForMatch(streamTitle);
    if (!t || !s)
        return 0;
    // Exact normalized match is the gold standard
    if (t === s) {
        // If we know the year and the stream also has a (different) year, be strict
        const sy = (0, cleaner_1.cleanTitle)(streamTitle).year;
        if (targetYear && sy && Math.abs(targetYear - sy) > 1)
            return 0.6;
        return 1.0;
    }
    const base = string_similarity_1.default.compareTwoStrings(t, s);
    const tTokens = t.split(' ').filter(Boolean);
    const sTokens = s.split(' ').filter(Boolean);
    const tSet = new Set(tTokens);
    const sSet = new Set(sTokens);
    // Every target word must be present in the stream title, otherwise it's a
    // different movie (e.g. "Batman" must not match "Batman Begins").
    const missing = tTokens.filter((w) => !sSet.has(w)).length;
    const extra = sTokens.filter((w) => !tSet.has(w)).length;
    // Hard reject when target words are missing from the stream
    if (missing > 0) {
        // allow a single tiny stopword miss only if base similarity is very high
        if (missing === 1 && base >= 0.9) {
            // continue with penalty
        }
        else {
            return Math.min(base, 0.45);
        }
    }
    // All target tokens present. Penalize each extra word in the stream title so
    // "The Batman" strongly beats "The Batman Returns Special Edition".
    let score = 0.9 - extra * 0.12;
    score = Math.max(score, base);
    // Year alignment strongly rewards/penalizes
    const sy = (0, cleaner_1.cleanTitle)(streamTitle).year;
    if (targetYear && sy) {
        if (Math.abs(targetYear - sy) <= 1)
            score += 0.08;
        else
            score -= 0.35; // wrong year → almost certainly a different title
    }
    return Math.max(0, Math.min(1, score));
}
/**
 * Rank IPTV items against a target title (plus optional alternative titles).
 * Returns the matching items with their score so callers can build streams or
 * resolve episodes.
 */
function rankMatches(targetTitle, streams, opts = {}) {
    const { targetYear, targetSeason, targetEpisode, altTitles = [], minScore = 0.82 } = opts;
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
            const sc = matchScore(title, stream.title, targetYear);
            if (sc > best)
                best = sc;
            if (best >= 0.99)
                break;
        }
        if (best >= minScore)
            matches.push({ item: stream, score: best });
    }
    matches.sort((a, b) => b.score - a.score);
    // De-duplicate by normalized title + resolved URL so we don't list the same
    // source many times, and drop anything far below the top match.
    const seen = new Set();
    const deduped = [];
    const topScore = matches.length ? matches[0].score : 0;
    for (const m of matches) {
        if (m.score < topScore - 0.15)
            break; // keep only near-best matches
        const key = `${normalizeForMatch(m.item.title)}|${m.item.url || m.item.streamId || ''}`;
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
