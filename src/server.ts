import express from 'express';
import cors from 'cors';
import path from 'path';
import { decodeConfig } from './utils/config';
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
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '7d',
  immutable: false,
  setHeaders(res, filePath) {
    if (/\.(png|svg|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  }
}));

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
  res.json({ ok: true, uptime: Math.round(process.uptime()), cache: cacheStats(), version: '1.0.1' });
});

// Stremio/Nuvio append `/configure` to the addon's base URL. For a configured
// install that base URL already contains the encoded config, so the request is
// `/<config>/configure`. Serve the same page (it self-hydrates from the path).
app.get('/:config/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/configure.html'));
});

// Real-time IPTV Connection Test API
app.post('/api/test-connection', rateLimit(12, 60_000), handleTestConnection);

// Manifest routes
app.get('/manifest.json', (req, res) => {
  const config = decodeConfig('');
  res.json(getManifest(config, getBaseUrl(req)));
});

app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  res.json(getManifest(config, getBaseUrl(req)));
});

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
