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
        // First try LZString decompression
        const decompressed = lz_string_1.default.decompressFromEncodedURIComponent(encoded);
        if (decompressed) {
            return JSON.parse(decompressed);
        }
        // Fallback: standard base64 URL safe
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    }
    catch (err) {
        console.error('Failed to decode config parameter:', err);
        return exports.defaultConfig;
    }
}
