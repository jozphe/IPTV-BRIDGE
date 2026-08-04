"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeItemId = encodeItemId;
exports.decodeItemId = decodeItemId;
exports.isItemId = isItemId;
const PREFIX = 'iptv:';
function toBase64Url(str) {
    return Buffer.from(str, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
function fromBase64Url(b64) {
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
    return Buffer.from(normalized, 'base64').toString('utf8');
}
function encodeItemId(item) {
    const ref = {
        k: item.type,
        t: item.title,
        y: item.year,
        u: item.url || undefined,
        sid: item.streamId,
        lg: item.logo,
        ci: item.containerExtension
    };
    return PREFIX + toBase64Url(JSON.stringify(ref));
}
function decodeItemId(id) {
    if (!id.startsWith(PREFIX))
        return { ref: null };
    const rest = id.slice(PREFIX.length);
    const parts = rest.split(':'); // [blob, season?, episode?]
    const blob = parts[0];
    let season;
    let episode;
    if (parts.length >= 3) {
        season = parseInt(parts[parts.length - 2], 10);
        episode = parseInt(parts[parts.length - 1], 10);
    }
    try {
        const ref = JSON.parse(fromBase64Url(blob));
        return { ref, season, episode };
    }
    catch {
        return { ref: null, season, episode };
    }
}
function isItemId(id) {
    return id.startsWith(PREFIX);
}
