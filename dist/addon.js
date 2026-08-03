"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManifest = getManifest;
exports.handleCatalog = handleCatalog;
exports.handleMeta = handleMeta;
exports.handleStream = handleStream;
const config_1 = require("./utils/config");
const provider_1 = require("./iptv/provider");
const tmdb_1 = require("./tmdb/tmdb");
const matcher_1 = require("./tmdb/matcher");
function stremioTypeToKind(type) {
    if (type === 'tv')
        return 'channel';
    if (type === 'movie')
        return 'movie';
    return 'series';
}
function getManifest(config) {
    const catalogs = [];
    if (config.includeLive !== false) {
        catalogs.push({
            type: 'tv',
            id: 'iptv_live',
            name: 'IPTV Live Channels',
            extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
        });
    }
    if (config.includeMovies !== false) {
        catalogs.push({
            type: 'movie',
            id: 'iptv_movies',
            name: 'IPTV Movies',
            extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
        });
    }
    if (config.includeSeries !== false) {
        catalogs.push({
            type: 'series',
            id: 'iptv_series',
            name: 'IPTV Series',
            extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }]
        });
    }
    return {
        id: 'org.stremio.nuvio.iptv',
        version: '1.0.0',
        name: 'IPTV Bridge (Stremio & Nuvio)',
        description: 'Serverless Xtream & M3U IPTV Addon with TMDB Resolution, Global Search & Clean Categorization',
        logo: 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv', 'movie', 'series'],
        catalogs,
        idPrefixes: ['tt', 'tmdb:', 'iptv:'],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };
}
async function handleCatalog(req, res) {
    try {
        const configParam = req.params.config || '';
        const config = (0, config_1.decodeConfig)(configParam);
        const { type, id, extra } = req.params;
        let searchQuery = '';
        if (extra) {
            const match = extra.match(/search=([^&]+)/);
            if (match)
                searchQuery = decodeURIComponent(match[1]);
        }
        let items = await (0, provider_1.getItems)(config, stremioTypeToKind(type));
        // Filter search
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            items = items.filter(item => item.title.toLowerCase().includes(q) || item.cleanTitle.toLowerCase().includes(q));
        }
        // Cap results for catalog view responsiveness
        items = items.slice(0, 100);
        // Format Stremio Metas
        const metas = items.map(item => ({
            id: `iptv:${encodeURIComponent(item.url || item.id)}`,
            type: type,
            name: item.title,
            poster: item.logo || 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
            description: `Category: ${item.category}`
        }));
        res.json({ metas });
    }
    catch (err) {
        console.error('Catalog Error:', err);
        res.json({ metas: [] });
    }
}
async function handleMeta(req, res) {
    try {
        const { id, type } = req.params;
        const configParam = req.params.config || '';
        const config = (0, config_1.decodeConfig)(configParam);
        if (id.startsWith('iptv:')) {
            const rawUrl = decodeURIComponent(id.replace(/^iptv:/, ''));
            res.json({
                meta: {
                    id,
                    type,
                    name: 'IPTV Stream',
                    poster: 'https://cdn-icons-png.flaticon.com/512/3172/3172554.png',
                    description: 'Direct IPTV Stream'
                }
            });
            return;
        }
        // Handle IMDB / TMDB IDs
        const tmdb = new tmdb_1.TMDBClient(config.tmdbApiKey);
        if (id.startsWith('tt')) {
            const resData = await tmdb.getByImdbId(id);
            if (resData) {
                const meta = tmdb.formatToStremioMeta(resData.details, resData.type);
                res.json({ meta });
                return;
            }
        }
        else if (id.startsWith('tmdb:')) {
            const tmdbId = id.replace('tmdb:', '');
            const details = await tmdb.getByTmdbId(tmdbId, type === 'movie' ? 'movie' : 'series');
            if (details) {
                const meta = tmdb.formatToStremioMeta(details, type === 'movie' ? 'movie' : 'series');
                res.json({ meta });
                return;
            }
        }
        res.json({ meta: null });
    }
    catch (err) {
        console.error('Meta Error:', err);
        res.json({ meta: null });
    }
}
async function handleStream(req, res) {
    try {
        const { id, type } = req.params;
        const configParam = req.params.config || '';
        const config = (0, config_1.decodeConfig)(configParam);
        // 1. Direct IPTV Stream URL ID
        if (id.startsWith('iptv:')) {
            const rawUrl = decodeURIComponent(id.replace(/^iptv:/, ''));
            const stream = {
                name: 'IPTV Direct',
                title: 'IPTV Live Stream',
                url: rawUrl
            };
            res.json({ streams: [stream] });
            return;
        }
        // 2. Global IMDB / TMDB ID resolution (Movie or Show episode requested in Stremio / Nuvio)
        let targetTitle = '';
        let targetYear;
        let targetSeason;
        let targetEpisode;
        // Extract episode info if present (e.g. tt123456:1:2 or tmdb:12345:1:2)
        const idParts = id.split(':');
        const baseId = idParts.length >= 2 && !id.startsWith('tmdb:') ? idParts[0] : idParts.slice(0, 2).join(':');
        if (idParts.length > 2) {
            targetSeason = parseInt(idParts[idParts.length - 2], 10);
            targetEpisode = parseInt(idParts[idParts.length - 1], 10);
        }
        const tmdb = new tmdb_1.TMDBClient(config.tmdbApiKey);
        if (baseId.startsWith('tt')) {
            const tmdbMatch = await tmdb.getByImdbId(baseId);
            if (tmdbMatch) {
                targetTitle = tmdbMatch.details.title || tmdbMatch.details.name || tmdbMatch.details.original_title;
                const releaseDate = tmdbMatch.details.release_date || tmdbMatch.details.first_air_date;
                if (releaseDate)
                    targetYear = parseInt(releaseDate.substring(0, 4), 10);
            }
        }
        else if (baseId.startsWith('tmdb:')) {
            const tmdbId = baseId.replace('tmdb:', '');
            const details = await tmdb.getByTmdbId(tmdbId, type === 'movie' ? 'movie' : 'series');
            if (details) {
                targetTitle = details.title || details.name || details.original_title;
                const releaseDate = details.release_date || details.first_air_date;
                if (releaseDate)
                    targetYear = parseInt(releaseDate.substring(0, 4), 10);
            }
        }
        if (!targetTitle) {
            res.json({ streams: [] });
            return;
        }
        // Fetch user streams to match against targetTitle
        const availableStreams = await (0, provider_1.getItems)(config, stremioTypeToKind(type));
        const streams = (0, matcher_1.filterAndSortMatchingStreams)(targetTitle, availableStreams, targetYear, targetSeason, targetEpisode);
        res.json({ streams });
    }
    catch (err) {
        console.error('Stream Error:', err);
        res.json({ streams: [] });
    }
}
