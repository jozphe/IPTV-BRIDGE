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
/** Resolve the configured category limit (0 = load everything). */
function categoryLimit(config) {
    const n = Number(config.categoryLimit) || 0;
    return n > 0 ? Math.min(Math.floor(n), 25) : 0;
}
/** Cap on how many per-category provider requests run at once. */
const CATEGORY_FETCH_CONCURRENCY = 6;
/**
 * Reduce a category list to the config's limit. The user's `includedCategories`
 * (ids/names/slugs) are honored when they match and padded with the provider's
 * next categories up to the limit (so stale picks never undershoot "load N");
 * a selection matching nothing falls back to the first N per type. The cap
 * applies PER TYPE (e.g. 3 movie + 3 series + 3 live with a limit of 3).
 */
function limitedCategoryList(all, config) {
    const limit = categoryLimit(config);
    if (!limit)
        return all;
    const chosen = config.includedCategories && config.includedCategories.length
        ? new Set(config.includedCategories.map(String))
        : null;
    let cats = all;
    if (chosen) {
        const filtered = all.filter((c) => chosen.has(c.id) || chosen.has(c.name) || chosen.has((0, cleaner_1.categorySlug)(c.name)));
        if (filtered.length) {
            // Keep user picks, then pad with unselected categories so the requested
            // number still loads if some picks are stale.
            const pickedIds = new Set(filtered.map((c) => c.id));
            cats = [...filtered, ...all.filter((c) => !pickedIds.has(c.id))];
        }
    }
    const out = [];
    for (const type of ['live', 'movie', 'series']) {
        out.push(...cats.filter((c) => c.type === type).slice(0, limit));
    }
    return out;
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
    const secrets = (0, cache_1.secretsFromConfig)(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        const xtType = kind === 'channel' ? 'live' : kind;
        const limit = categoryLimit(config);
        if (limit) {
            // FAST PATH: fetch only the limited categories, one small request each
            // (cached per category), instead of the panel's giant full-type
            // download. This keeps cold catalogs/search near-instant.
            const cats = limitedCategoryList(await fetchAllCategories(config), config)
                .filter((c) => c.type === xtType);
            if (!cats.length) {
                // Categories unavailable (endpoint failure) — fall back to the full
                // fetch so the addon still has content.
                return (0, cache_1.staleWhileRevalidate)(`xt:streams:${fp}:${xtType}`, cache_1.TTL.STREAMS, async () => {
                    const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
                    return client.getStreams(xtType);
                }, { secrets });
            }
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            const groups = [];
            // Bounded concurrency so a large limit never hammers the panel.
            for (let i = 0; i < cats.length; i += CATEGORY_FETCH_CONCURRENCY) {
                const batch = cats.slice(i, i + CATEGORY_FETCH_CONCURRENCY);
                const results = await Promise.all(batch.map((cat) => (0, cache_1.staleWhileRevalidate)(`xt:streams:${fp}:${xtType}:cat_${cat.id}`, cache_1.TTL.STREAMS, () => client.getStreams(xtType, cat.id), { secrets })));
                groups.push(...results);
            }
            return groups.flat();
        }
        return (0, cache_1.staleWhileRevalidate)(`xt:streams:${fp}:${xtType}`, cache_1.TTL.STREAMS, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getStreams(xtType);
        }, { secrets });
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        const parsed = await fetchParsedM3U(config);
        const kindItems = parsed.items.filter((item) => item.type === kind);
        if (!categoryLimit(config))
            return kindItems;
        // Only the limited categories' items (the playlist file itself must still
        // be downloaded+parsed once, but everything downstream is small). If the
        // category list is unavailable, show everything rather than nothing.
        const limited = limitedCategoryList(parsed.categories, config);
        if (!limited.length)
            return kindItems;
        const allowed = new Set(limited.map((c) => c.id));
        return kindItems.filter((i) => allowed.has(i.categoryId || ''));
    }
    return [];
}
async function getAllCategories(config) {
    return limitedCategoryList(await fetchAllCategories(config), config);
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
