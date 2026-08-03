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

// Configurator Web UI routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/configure.html'));
});

// Real-time IPTV Connection Test API
app.post('/api/test-connection', handleTestConnection);

// Manifest routes
app.get('/manifest.json', (req, res) => {
  const config = decodeConfig('');
  res.json(getManifest(config));
});

app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  res.json(getManifest(config));
});

// Catalog routes
app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/:config/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/:extra.json', handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', handleCatalog);

// Meta routes
app.get('/meta/:type/:id.json', handleMeta);
app.get('/:config/meta/:type/:id.json', handleMeta);

// Stream routes
app.get('/stream/:type/:id.json', handleStream);
app.get('/:config/stream/:type/:id.json', handleStream);

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`IPTV Addon Server running at http://localhost:${PORT}`);
  });
}

export default app;
