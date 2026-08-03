"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getItems = getItems;
exports.getCategories = getCategories;
const xtream_1 = require("./xtream");
const m3u_1 = require("./m3u");
const cache_1 = require("../utils/cache");
const crypto_1 = __importDefault(require("crypto"));
function configFingerprint(config) {
    const raw = config.type === 'xtream'
        ? `xt|${config.host}|${config.username}|${config.password}`
        : `m3u|${config.m3uUrl}`;
    return crypto_1.default.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
/**
 * Fetch every IPTV item for a given media kind, cached per-provider.
 * Xtream fetches only the relevant type; M3U parses once and is reused across
 * all kinds via a single cached parse.
 */
async function getItems(config, kind) {
    const fp = configFingerprint(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        const xtType = kind === 'channel' ? 'live' : kind;
        return (0, cache_1.cached)(`xt:streams:${fp}:${xtType}`, cache_1.TTL.STREAMS, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getStreams(xtType);
        });
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        const parsed = await (0, cache_1.cached)(`m3u:parsed:${fp}`, cache_1.TTL.PLAYLIST, () => (0, m3u_1.parseM3UPlaylist)(config.m3uUrl, config.includedCategories));
        return parsed.items.filter((item) => item.type === kind);
    }
    return [];
}
async function getCategories(config) {
    const fp = configFingerprint(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        return (0, cache_1.cached)(`xt:cats:${fp}`, cache_1.TTL.CATEGORIES, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getCategories();
        });
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        const parsed = await (0, cache_1.cached)(`m3u:parsed:${fp}`, cache_1.TTL.PLAYLIST, () => (0, m3u_1.parseM3UPlaylist)(config.m3uUrl, config.includedCategories));
        return parsed.categories;
    }
    return [];
}
