"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTestConnection = handleTestConnection;
const xtream_1 = require("../iptv/xtream");
const m3u_1 = require("../iptv/m3u");
const provider_1 = require("../iptv/provider");
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../utils/config");
async function handleTestConnection(req, res) {
    try {
        const { type, host, username, password, m3uUrl, tmdbApiKey } = req.body;
        const configError = (0, config_1.validateConfig)({ type, host, username, password, m3uUrl });
        if (configError) {
            res.status(400).json({ success: false, error: configError });
            return;
        }
        let categories = [];
        let statusMessage = 'Connection successful!';
        let tmdbValid = false;
        // Test TMDB Key if provided
        if (tmdbApiKey) {
            try {
                const tmdbRes = await axios_1.default.get(`https://api.themoviedb.org/3/configuration?api_key=${tmdbApiKey}`, { timeout: 5000 });
                if (tmdbRes.data && tmdbRes.data.images) {
                    tmdbValid = true;
                }
            }
            catch (e) {
                tmdbValid = false;
            }
        }
        if (type === 'xtream') {
            if (!host || !username || !password) {
                res.status(400).json({ success: false, error: 'Host, Username, and Password are required.' });
                return;
            }
            const client = new xtream_1.XtreamClient(host, username, password);
            const [authData, loadedCategories] = await Promise.all([
                client.authenticate(),
                client.getCategories()
            ]);
            categories = loadedCategories;
            const userInfo = authData?.user_info;
            statusMessage = `Connected! User: ${userInfo?.username || username} (Status: ${userInfo?.status || 'Active'})`;
            // Warm the shared cache (streams) in the background so the first
            // Stremio/Nuvio user hits a warm cache instead of a slow cold fetch.
            void (0, provider_1.warmProviderCache)({ type: 'xtream', host, username, password }).catch(() => undefined);
            res.json({
                success: true,
                message: statusMessage,
                categories,
                tmdbValid,
                userInfo: {
                    username: userInfo?.username,
                    status: userInfo?.status,
                    expDate: userInfo?.exp_date ? new Date(parseInt(userInfo.exp_date, 10) * 1000).toLocaleDateString() : 'Unlimited',
                    activeCons: `${userInfo?.active_cons || 0} / ${userInfo?.max_connections || '∞'}`
                }
            });
            return;
        }
        else if (type === 'm3u') {
            if (!m3uUrl) {
                res.status(400).json({ success: false, error: 'M3U Playlist URL is required.' });
                return;
            }
            const parsed = await (0, m3u_1.parseM3UPlaylist)(m3uUrl);
            // NOTE: no warm-up here — the playlist was JUST parsed by this test, and
            // the configurator's "Generate link" fires /warmup (which caches under
            // the addon's fingerprint) right after. Skipping avoids a second full
            // download+parse of large playlists at configure time.
            res.json({
                success: true,
                message: `M3U Playlist parsed successfully! Found ${parsed.items.length} items across ${parsed.categories.length} categories.`,
                categories: parsed.categories,
                tmdbValid,
                totalItems: parsed.items.length
            });
            return;
        }
        res.status(400).json({ success: false, error: 'Invalid configuration type.' });
    }
    catch (err) {
        const status = err?.response?.status;
        const message = status === 401 || status === 403
            ? 'Provider rejected the credentials.'
            : err?.code === 'ECONNABORTED'
                ? 'Provider timed out. Try again or contact the IPTV provider.'
                : err.message || 'Failed to connect to IPTV provider. Check URL or credentials.';
        console.error('Test Connection Error:', { code: err?.code, status });
        res.status(status === 401 || status === 403 ? 401 : 502).json({
            success: false,
            error: message
        });
    }
}
