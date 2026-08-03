"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchStreamTitle = matchStreamTitle;
exports.filterAndSortMatchingStreams = filterAndSortMatchingStreams;
const string_similarity_1 = __importDefault(require("string-similarity"));
const cleaner_1 = require("../iptv/cleaner");
function matchStreamTitle(targetTitle, streamTitle, targetYear) {
    const cleanTarget = (0, cleaner_1.cleanTitle)(targetTitle).cleanTitle.toLowerCase();
    const cleanStream = (0, cleaner_1.cleanTitle)(streamTitle).cleanTitle.toLowerCase();
    if (!cleanTarget || !cleanStream)
        return 0;
    // Exact match
    if (cleanTarget === cleanStream)
        return 1.0;
    // String similarity score
    let score = string_similarity_1.default.compareTwoStrings(cleanTarget, cleanStream);
    // Bonus if target title is contained inside stream title
    if (cleanStream.includes(cleanTarget)) {
        score = Math.max(score, 0.85);
    }
    // Penalty if years are present and differ
    const streamYear = (0, cleaner_1.cleanTitle)(streamTitle).year;
    if (targetYear && streamYear && Math.abs(targetYear - streamYear) > 1) {
        score *= 0.5;
    }
    return score;
}
function filterAndSortMatchingStreams(targetTitle, streams, targetYear, targetSeason, targetEpisode, minScore = 0.55) {
    const matches = [];
    for (const stream of streams) {
        // If series episode request, verify season and episode match
        if (targetSeason !== undefined && targetEpisode !== undefined) {
            const parsed = (0, cleaner_1.cleanTitle)(stream.title);
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
        const parsed = (0, cleaner_1.cleanTitle)(item.title);
        const qualityStr = parsed.quality ? ` [${parsed.quality}]` : '';
        const catStr = item.category ? ` • ${item.category}` : '';
        return {
            name: `IPTV${qualityStr}`,
            title: `${item.title}${catStr}`,
            url: item.url || ''
        };
    });
}
