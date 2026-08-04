import express from 'express';
import cors from 'cors';
import path from 'path';
import { decodeConfig } from './utils/config';
import { getManifest, handleCatalog, handleMeta, handleStream } from './addon';
import { handleTestConnection } from './api/testConnection';

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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

// Stremio/Nuvio append `/configure` to the addon's base URL. For a configured
// install that base URL already contains the encoded config, so the request is
// `/<config>/configure`. Serve the same page (it self-hydrates from the path).
app.get('/:config/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/configure.html'));
});

// Real-time IPTV Connection Test API
app.post('/api/test-connection', handleTestConnection);

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
