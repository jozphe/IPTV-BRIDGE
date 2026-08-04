"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultConfig = void 0;
exports.encodeConfig = encodeConfig;
exports.decodeConfig = decodeConfig;
const lz_string_1 = __importDefault(require("lz-string"));
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
    return config;
}
