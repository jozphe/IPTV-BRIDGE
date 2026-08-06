"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getItems = getItems;
exports.getCategories = getCategories;
exports.getTitleMatches = getTitleMatches;
const xtream_1 = require("./xtream");
const m3u_1 = require("./m3u");
const cache_1 = require("../utils/cache");
const crypto_1 = __importDefault(require("crypto"));
const cleaner_1 = require("./cleaner");
/**
 * Build a matcher honoring the configurator's category selection.
 * `includedCategories` stores category ids (Xtream `live_5` / `vod_45`,
 * M3U name-slugs) but items only expose the category NAME, so we match on
 * id OR name OR slugified name to cover every provider shape.
 */
function buildCategoryMatcher(config) {
    const selected = config.includedCategories;
    if (!selected || !selected.length)
        return null;
    const ids = new Set(selected.map(String));
    const slugs = new Set(selected.map((s) => (0, cleaner_1.categorySlug)(String(s))));
    return (id, name) => {
        const idStr = id ? String(id) : '';
        return ids.has(idStr) || ids.has(name) || slugs.has((0, cleaner_1.categorySlug)(idStr)) || slugs.has((0, cleaner_1.categorySlug)(name));
    };
}
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
/**
 * Apply the configurator's category selection to a full item/category list.
 * If the selection matches NOTHING (e.g. the playlist was replaced or renamed
 * its groups since the manifest link was created), it is treated as stale and
 * the full list is returned instead of an empty/trimmed catalog.
 */
function applySelection(list, selected, getId, getName) {
    if (!selected || !list.length)
        return list;
    const filtered = list.filter((item) => selected(getId(item), getName(item)));
    return filtered.length ? filtered : list;
}
/**
 * Fetch the provider's FULL category list (no selection applied, never
 * trimmed). Used to decide whether a selection is stale provider-wide.
 */
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
/**
 * Staleness gate (pure): a selection is "stale" only when it matches NO
 * category in the provider's full category list (playlist replaced/renamed
 * since the link was created). Partial matches are respected strictly —
 * deliberately deselected types must not be flooded back in. An empty
 * category list can't prove staleness, so it is treated as "not stale"
 * (strict filtering) rather than guessing.
 */
function selectionIsStale(selected, all) {
    if (!selected || !all.length)
        return false;
    return !all.some((cat) => selected(cat.id, cat.name));
}
async function getItems(config, kind) {
    const fp = configFingerprint(config);
    const selected = buildCategoryMatcher(config);
    if (config.type === 'xtream' && config.host && config.username && config.password) {
        const xtType = kind === 'channel' ? 'live' : kind;
        // The matcher must run AFTER the cached fetch: the cache key only covers
        // credentials, so filtering inside the producer would serve one user's
        // category selection to every other user sharing the same provider.
        // The staleness check needs the full category list; fetch it in parallel
        // so a cold cache costs max(streams, cats) instead of their sum.
        const itemsP = (0, cache_1.staleWhileRevalidate)(`xt:streams:${fp}:${xtType}`, cache_1.TTL.STREAMS, async () => {
            const client = new xtream_1.XtreamClient(config.host, config.username, config.password);
            return client.getStreams(xtType);
        }, { secrets: (0, cache_1.secretsFromConfig)(config) });
        const catsP = selected
            ? fetchAllCategories(config).catch((err) => {
                // Can't judge staleness — fall back to strict filtering.
                console.error('Category staleness check failed:', err);
                return [];
            })
            : Promise.resolve([]);
        const [items, allCats] = await Promise.all([itemsP, catsP]);
        if (!selected)
            return items;
        if (selectionIsStale(selected, allCats))
            return items; // entirely stale selection
        return items.filter((i) => selected(i.categoryId, i.category)); // strict per-kind
    }
    if (config.type === 'm3u' && config.m3uUrl) {
        // Parse the complete source once. Category filtering belongs after the
        // parse, otherwise a cache entry created for one selection can poison a
        // later request with a different category selection.
        const parsed = await fetchParsedM3U(config);
        const kindItems = parsed.items.filter((item) => item.type === kind);
        if (!selected)
            return kindItems;
        if (selectionIsStale(selected, parsed.categories))
            return kindItems; // entirely stale selection
        return kindItems.filter((i) => selected(i.categoryId, i.category)); // strict per-kind
    }
    return [];
}
async function getCategories(config) {
    const selected = buildCategoryMatcher(config);
    const all = await fetchAllCategories(config);
    // The input here is the FULL list, so a zero-match fallback is exactly the
    // whole-provider staleness case (playlist replaced) — deliberate per-type
    // deselection can't be misread because the full list has matches elsewhere.
    return applySelection(all, selected, (c) => c.id, (c) => c.name);
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
