"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.XtreamClient = void 0;
const axios_1 = __importDefault(require("axios"));
const cleaner_1 = require("./cleaner");
class XtreamClient {
    host;
    username;
    password;
    constructor(host, username, password) {
        // Normalize host
        let cleanHost = host.trim();
        if (!cleanHost.startsWith('http://') && !cleanHost.startsWith('https://')) {
            cleanHost = `http://${cleanHost}`;
        }
        this.host = cleanHost.replace(/\/+$/, '');
        this.username = username.trim();
        this.password = password.trim();
    }
    get baseApiUrl() {
        return `${this.host}/player_api.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    }
    async authenticate() {
        const response = await axios_1.default.get(this.baseApiUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0 (Windows; IPTV Addon)' }
        });
        if (response.data?.user_info?.status === 'Disabled') {
            throw new Error('Xtream Codes account is disabled');
        }
        return response.data;
    }
    async getCategories() {
        const categories = [];
        try {
            const [liveRes, vodRes, seriesRes] = await Promise.allSettled([
                axios_1.default.get(`${this.baseApiUrl}&action=get_live_categories`, { timeout: 10000 }),
                axios_1.default.get(`${this.baseApiUrl}&action=get_vod_categories`, { timeout: 10000 }),
                axios_1.default.get(`${this.baseApiUrl}&action=get_series_categories`, { timeout: 10000 })
            ]);
            if (liveRes.status === 'fulfilled' && Array.isArray(liveRes.value.data)) {
                liveRes.value.data.forEach((cat) => {
                    categories.push({ id: `live_${cat.category_id}`, name: cat.category_name, type: 'live' });
                });
            }
            if (vodRes.status === 'fulfilled' && Array.isArray(vodRes.value.data)) {
                vodRes.value.data.forEach((cat) => {
                    categories.push({ id: `vod_${cat.category_id}`, name: cat.category_name, type: 'movie' });
                });
            }
            if (seriesRes.status === 'fulfilled' && Array.isArray(seriesRes.value.data)) {
                seriesRes.value.data.forEach((cat) => {
                    categories.push({ id: `series_${cat.category_id}`, name: cat.category_name, type: 'series' });
                });
            }
        }
        catch (err) {
            console.error('Failed to fetch Xtream categories:', err);
        }
        return categories;
    }
    async getStreams(type, categoryId) {
        let action = 'get_live_streams';
        if (type === 'movie')
            action = 'get_vod_streams';
        if (type === 'series')
            action = 'get_series_streams';
        let url = `${this.baseApiUrl}&action=${action}`;
        if (categoryId) {
            // Strip prefix if needed
            const rawCatId = categoryId.replace(/^(live|vod|series)_/, '');
            url += `&category_id=${encodeURIComponent(rawCatId)}`;
        }
        const response = await axios_1.default.get(url, {
            timeout: 12000,
            headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0' }
        });
        if (!Array.isArray(response.data)) {
            return [];
        }
        return response.data.map((stream) => {
            const title = stream.name || 'Untitled Stream';
            const cleaned = (0, cleaner_1.cleanTitle)(title);
            const streamId = stream.stream_id || stream.series_id;
            const ext = stream.container_extension || 'mp4';
            let streamUrl = '';
            if (type === 'live') {
                streamUrl = `${this.host}/live/${this.username}/${this.password}/${streamId}.m3u8`;
            }
            else if (type === 'movie') {
                streamUrl = `${this.host}/movie/${this.username}/${this.password}/${streamId}.${ext}`;
            }
            else {
                streamUrl = `${this.host}/series/${this.username}/${this.password}/${streamId}.${ext}`;
            }
            return {
                id: `xt_${type}_${streamId}`,
                streamId,
                title,
                cleanTitle: cleaned.cleanTitle,
                type: type === 'live' ? 'channel' : type,
                category: stream.category_name || type,
                logo: stream.stream_icon || stream.cover,
                url: streamUrl,
                year: cleaned.year || (stream.year ? parseInt(stream.year, 10) : undefined),
                containerExtension: ext
            };
        });
    }
    async getSeriesEpisodes(seriesId) {
        const rawId = String(seriesId).replace(/^xt_series_/, '');
        const url = `${this.baseApiUrl}&action=get_series_info&series_id=${encodeURIComponent(rawId)}`;
        const response = await axios_1.default.get(url, { timeout: 10000 });
        return response.data;
    }
    buildEpisodeUrl(episodeId, extension = 'mp4') {
        return `${this.host}/series/${this.username}/${this.password}/${episodeId}.${extension}`;
    }
}
exports.XtreamClient = XtreamClient;
