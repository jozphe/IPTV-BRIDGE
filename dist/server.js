"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./utils/config");
const addon_1 = require("./addon");
const testConnection_1 = require("./api/testConnection");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 7000;
app.use((0, cors_1.default)({ origin: '*' }));
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// Configurator Web UI routes
app.get('/', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/index.html'));
});
app.get('/configure', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/configure.html'));
});
// Real-time IPTV Connection Test API
app.post('/api/test-connection', testConnection_1.handleTestConnection);
// Manifest routes
app.get('/manifest.json', (req, res) => {
    const config = (0, config_1.decodeConfig)('');
    res.json((0, addon_1.getManifest)(config));
});
app.get('/:config/manifest.json', (req, res) => {
    const config = (0, config_1.decodeConfig)(req.params.config);
    res.json((0, addon_1.getManifest)(config));
});
// Catalog routes
app.get('/catalog/:type/:id.json', addon_1.handleCatalog);
app.get('/:config/catalog/:type/:id.json', addon_1.handleCatalog);
app.get('/catalog/:type/:id/:extra.json', addon_1.handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', addon_1.handleCatalog);
// Meta routes
app.get('/meta/:type/:id.json', addon_1.handleMeta);
app.get('/:config/meta/:type/:id.json', addon_1.handleMeta);
// Stream routes
app.get('/stream/:type/:id.json', addon_1.handleStream);
app.get('/:config/stream/:type/:id.json', addon_1.handleStream);
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`IPTV Addon Server running at http://localhost:${PORT}`);
    });
}
exports.default = app;
