import express from 'express';
import cors from 'cors';
import path from 'path';
import { decodeConfig } from './utils/config';
import { UserConfig } from './types';
import { getManifest, handleCatalog, handleMeta, handleStream } from './addon';
import { handleTestConnection } from './api/testConnection';
import { cacheStats } from './utils/cache';
import { rateLimit, securityHeaders } from './utils/security';

const app = express();
const PORT = process.env.PORT || 7000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '32kb', strict: true }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.includes('/catalog/') || req.path.includes('/stream/') || req.path.includes('/meta/')) {
      console.info(JSON.stringify({ event: 'request', path: req.path.replace(/^\/[^/]+\//, '/:config/'), status: res.statusCode, total_ms: Date.now() - started }));
    }
  });
  next();
});

// Resolve the public base URL of the current request (works behind Vercel proxy)
function getBaseUrl(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
  return `${proto}://${host}`;
}

// Configurator Web UI routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/configure.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/docs.html'));
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()), cache: cacheStats(), version: '1.1.0' });
});

// Stremio/Nuvio append `/configure` to the addon's base URL. For a configured
// install that base URL already contains the encoded config, so the request is
// `/<config>/configure`. Serve the same page (it self-hydrates from the path).
app.get('/:config/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/configure.html'));
});

// Real-time IPTV Connection Test API
app.post('/api/test-connection', rateLimit(12, 60_000), handleTestConnection);

// Manifest routes. Async because the manifest now embeds the user's real IPTV
// categories (cached) as genre options + per-category catalogs.
async function sendManifest(res: express.Response, config: UserConfig, baseUrl: string) {
  res.setHeader('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600');
  try {
    res.json(await getManifest(config, baseUrl));
  } catch (err) {
    console.error('Manifest Error:', err);
    res.status(500).json({ error: 'Failed to build manifest' });
  }
}

app.get('/manifest.json', (req, res) => {
  sendManifest(res, decodeConfig(''), getBaseUrl(req));
});

// Public ownership-validation manifest for stremio-addons.net.
app.get('/demo-manifest.json', (req, res) => {
  sendManifest(res, decodeConfig(''), getBaseUrl(req));
});

app.get('/:config/manifest.json', (req, res) => {
  sendManifest(res, decodeConfig(req.params.config), getBaseUrl(req));
});

// Static assets are served AFTER the manifest routes so a bare `/manifest.json`
// request hits the dynamic handler (correct logo + version) instead of the
// static placeholder in public/.
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '7d',
  immutable: false,
  setHeaders(res, filePath) {
    if (/\.(png|svg|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  }
}));

// Catalog routes
app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/:config/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/:extra.json', handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', handleCatalog);

// Meta routes (id carries our base64url blob + optional :season:episode)
app.get('/meta/:type/:id.json', handleMeta);
app.get('/:config/meta/:type/:id.json', handleMeta);

// Stream routes (id carries our base64url blob or tt/tmdb id + suffixes)
app.get('/stream/:type/:id.json', handleStream);
app.get('/:config/stream/:type/:id.json', handleStream);

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`IPTV Addon Server running at http://localhost:${PORT}`);
  });
}

export default app;
