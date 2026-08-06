"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getItems = getItems;
exports.getAllCategories = getAllCategories;
exports.warmProviderCache = warmProviderCache;
exports.getTitleMatches = getTitleMatches;
const xtream_1 = require("./xtream");
const m3u_1 = require("./m3u");
const cache_1 = require("../utils/cache");
const crypto_1 = __importDefault(require("crypto"));
const cleaner_1 = require("./cleaner");
function configFingerprint(config) {
    const raw = config.type === 'xtream'
        ? `xt|${config.host}|${config.username}|${config.password}`
        : `m3u|${config.m3uUrl}`;
    return crypto_1.default.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
/** Fetch the provider's FULL category list (never trimmed). */
async function fetchAllCategories(config) {
    const fp = configFingerprint(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        return (0, cache_1.staleWhileRevalidate)(`xt:cats:${fp}`, cache_1.TTL.CATEGORIES, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getCategories();
        }, { secrets: (0, cache_1.secretsFromConfig)(config) });
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        const parsed = await fetchParsedM3U(config);
        return parsed.categories;
    }
    return [];
}
/** Parse the M3U source once, cached per-provider (shared by items & categories). */
function fetchParsedM3U(config) {
    const fp = configFingerprint(config);
    return (0, cache_1.staleWhileRevalidate)(`m3u:parsed:${fp}`, cache_1.TTL.PLAYLIST, () => (0, m3u_1.parseM3UPlaylist)(config.m3uUrl), { secrets: (0, cache_1.secretsFromConfig)(config) });
}
async function getItems(config, kind) {
    const fp = configFingerprint(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        const xtType = kind === 'channel' ? 'live' : kind;
        return (0, cache_1.staleWhileRevalidate)(`xt:streams:${fp}:${xtType}`, cache_1.TTL.STREAMS, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getStreams(xtType);
        }, { secrets: (0, cache_1.secretsFromConfig)(config) });
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        const parsed = await fetchParsedM3U(config);
        return parsed.items.filter((item) => item.type === kind);
    }
    return [];
}
async function getAllCategories(config) {
    return fetchAllCategories(config);
}
/**
 * Pre-fetch everything the addon needs for a config so the FIRST user never
 * waits on a cold cache. Results land under the same fingerprint keys the
 * addon reads. Best effort — callers fire it without awaiting (configure
 * time, manifest loads); failures just mean the normal path warms instead.
 */
async function warmProviderCache(config) {
    try {
        if (config.type === 'xtream' && config.host && config.username && config.password) {
            await Promise.allSettled([
                fetchAllCategories(config),
                getItems(config, 'channel'),
                getItems(config, 'movie'),
                getItems(config, 'series')
            ]);
        }
        else if (config.type === 'm3u' && config.m3uUrl) {
            // One cached parse covers items AND categories for M3U.
            await Promise.allSettled([fetchParsedM3U(config)]);
        }
    }
    catch (err) {
        console.error('Cache warm-up failed (non-fatal):', err);
    }
}
async function getTitleMatches(config, kind, titles) {
    const fp = configFingerprint(config);
    const items = await getItems(config, kind);
    // Not JSON-serializable and trivially rebuilt from the shared stream list,
    // so this index stays per-instance and is never written to Redis.
    const index = await (0, cache_1.cached)(`title-index:${fp}:${kind}`, cache_1.TTL.STREAMS, async () => {
        const map = new Map();
        for (const item of items) {
            const key = (0, cleaner_1.titleIdentity)(item.title);
            if (!key)
                continue;
            const list = map.get(key) || [];
            list.push(item);
            map.set(key, list);
        }
        return map;
    }, { shared: false });
    const matches = [];
    const seen = new Set();
    for (const title of titles) {
        const key = (0, cleaner_1.titleIdentity)(title);
        for (const item of index.get(key) || []) {
            const identity = String(item.streamId ?? item.url ?? item.id);
            if (seen.has(identity))
                continue;
            seen.add(identity);
            matches.push(item);
        }
    }
    return matches;
}
