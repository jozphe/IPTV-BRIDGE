"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultConfig = void 0;
exports.encodeConfig = encodeConfig;
exports.decodeConfig = decodeConfig;
exports.validateConfig = validateConfig;
const lz_string_1 = __importDefault(require("lz-string"));
const security_1 = require("./security");
const MAX_CONFIG_LENGTH = 16_384;
exports.defaultConfig = {
    type: 'm3u',
    includeLive: true,
    includeMovies: true,
    includeSeries: true,
    streamType: 'auto'
};
function encodeConfig(config) {
    const jsonStr = JSON.stringify(config);
    return lz_string_1.default.compressToEncodedURIComponent(jsonStr);
}
function decodeConfig(encoded) {
    try {
        if (!encoded)
            return exports.defaultConfig;
        if (encoded.length > MAX_CONFIG_LENGTH)
            return exports.defaultConfig;
        // Some clients preserve an escaped path segment when opening an addon
        // link. Decode it before passing it to LZString.
        const safeEncoded = decodeURIComponent(encoded);
        // First try LZString decompression
        const decompressed = lz_string_1.default.decompressFromEncodedURIComponent(safeEncoded);
        if (decompressed) {
            return normalizeConfig(JSON.parse(decompressed));
        }
        // Fallback: standard base64 URL safe
        const base64 = safeEncoded.replace(/-/g, '+').replace(/_/g, '/');
        const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
        return normalizeConfig(JSON.parse(jsonStr));
    }
    catch (err) {
        console.error('Failed to decode config parameter:', err);
        return exports.defaultConfig;
    }
}
function validateConfig(config) {
    if (config.type === 'xtream') {
        if (!config.host || !config.username || !config.password)
            return 'Xtream host, username and password are required.';
        if (config.username.length > 512 || config.password.length > 512)
            return 'Provider credentials are too long.';
        if (!(0, security_1.isSafeUpstreamUrl)(config.host))
            return 'Xtream host must be a valid public HTTP or HTTPS URL.';
    }
    else {
        if (!config.m3uUrl)
            return 'M3U playlist URL is required.';
        if (!(0, security_1.isSafeUpstreamUrl)(config.m3uUrl))
            return 'M3U URL must be a valid public HTTP or HTTPS URL.';
    }
    if (config.tmdbApiKey && config.tmdbApiKey.length > 512)
        return 'TMDB key is too long.';
    if (config.includedCategories && config.includedCategories.length > 2000)
        return 'Too many categories selected.';
    const limit = config.categoryLimit ? Number(config.categoryLimit) : 0;
    if (!Number.isFinite(limit) || limit < 0 || limit > 25)
        return 'Category limit must be between 0 and 25.';
    return null;
}
function normalizeConfig(value) {
    if (!value || typeof value !== 'object')
        return exports.defaultConfig;
    const config = {
        ...exports.defaultConfig,
        ...value,
        type: value.type === 'xtream' ? 'xtream' : 'm3u'
    };
    if (Array.isArray(value.includedCategories)) {
        config.includedCategories = value.includedCategories.map(String).filter(Boolean);
    }
    if (value.categoryLimit !== undefined) {
        const n = Number(value.categoryLimit);
        config.categoryLimit = Number.isFinite(n) ? Math.max(0, Math.min(25, Math.floor(n))) : 0;
    }
    return config;
}
