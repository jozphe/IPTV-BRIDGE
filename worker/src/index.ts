// Worker entrypoint: addon protocol (per-user config in the URL) + configurator
// UI (static assets). No cron / no scheduled handler — each user brings their
// own credentials, so there is nothing global to refresh.
//
// URL shape (unchanged from the original addon, so existing installs keep
// working): https://<domain>/<compressed-config>/manifest.json

import { decodeConfig } from './config';
import { getManifest } from './manifest';
import { CatalogParams, handleCatalog, handleMeta, handleStream } from './handlers';
import { CACHE, corsPreflight, json } from './responses';
import { XtreamClient } from './xtream';
import { Env } from './types';

const ROUTE_KEYWORDS = new Set([
  'manifest.json',
  'demo-manifest.json',
  'catalog',
  'meta',
  'stream',
  'configure',
  'api',
  'health'
]);

const stripJson = (s: string): string => (s.endsWith('.json') ? s.slice(0, -5) : s);

function assetResponse(env: Env, request: Request, path?: string): Promise<Response> {
  if (!path) return env.ASSETS.fetch(request);
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

async function testConnection(request: Request): Promise<Response> {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const { type, host, username, password, m3uUrl, tmdbApiKey } = body || {};

  let tmdbValid = false;
  if (tmdbApiKey) {
    try {
      const r = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(tmdbApiKey)}`);
      tmdbValid = r.ok;
    } catch {
      tmdbValid = false;
    }
  }

  try {
    if (type === 'xtream') {
      if (!host || !username || !password)
        return json({ success: false, error: 'Host, Username, and Password are required.' }, { status: 400 });
      const client = new XtreamClient(host, username, password);
      const [auth, live, movie, series] = await Promise.all([
        client.authenticate(),
        client.getCategories('live').catch(() => []),
        client.getCategories('movie').catch(() => []),
        client.getCategories('series').catch(() => [])
      ]);
      const info = auth?.user_info;
      const categories = [
        ...live.map((c) => ({ id: `live_${c.category_id}`, name: c.category_name, type: 'live' })),
        ...movie.map((c) => ({ id: `vod_${c.category_id}`, name: c.category_name, type: 'movie' })),
        ...series.map((c) => ({ id: `series_${c.category_id}`, name: c.category_name, type: 'series' }))
      ];
      return json({
        success: true,
        message: `Connected! User: ${info?.username || username} (Status: ${info?.status || 'Active'})`,
        categories,
        tmdbValid,
        userInfo: {
          username: info?.username,
          status: info?.status,
          expDate: info?.exp_date ? new Date(parseInt(info.exp_date, 10) * 1000).toLocaleDateString() : 'Unlimited',
          activeCons: `${info?.active_cons || 0} / ${info?.max_connections || '\u221e'}`
        }
      });
    }

    if (type === 'm3u') {
      if (!m3uUrl) return json({ success: false, error: 'M3U Playlist URL is required.' }, { status: 400 });
      const r = await fetch(m3uUrl, { headers: { 'User-Agent': 'IPTVSmartersPro/3.0.0' } });
      if (!r.ok) return json({ success: false, error: `Playlist fetch failed (${r.status}).` }, { status: 502 });
      const text = await r.text();
      const count = (text.match(/#EXTINF:/g) || []).length;
      return json({ success: true, message: `M3U parsed. Found ${count} entries.`, tmdbValid, totalItems: count });
    }

    return json({ success: false, error: 'Invalid configuration type.' }, { status: 400 });
  } catch (err: any) {
    return json({ success: false, error: err?.message || 'Connection failed.' }, { status: 502 });
  }
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') return corsPreflight();

  const url = new URL(request.url);
  const origin = url.origin;
  const segments = url.pathname.split('/').filter(Boolean);

  // Split into leading (per-user config) segment(s) and the addon route.
  const idx = segments.findIndex((s) => ROUTE_KEYWORDS.has(s));
  const configStr = idx > 0 ? segments.slice(0, idx).join('/') : '';
  const route = idx >= 0 ? segments.slice(idx) : segments;
  const head = route[0];

  // Manifest
  if (head === 'manifest.json' || head === 'demo-manifest.json') {
    const config = decodeConfig(configStr);
    const manifest = await getManifest(config, origin, ctx);
    return json(manifest, { cache: CACHE.manifest });
  }

  // Catalog: catalog/:type/:id[.json] | catalog/:type/:id/:extra.json
  if (head === 'catalog' && route.length >= 3) {
    const config = decodeConfig(configStr);
    const type = route[1];
    const extra = route.length >= 4 ? stripJson(route[3]) : '';
    const params: CatalogParams = { type, extra, search: url.searchParams };
    return handleCatalog(env, config, params, origin, ctx);
  }

  // Meta: meta/:type/:id.json
  if (head === 'meta' && route.length >= 3) {
    const config = decodeConfig(configStr);
    const type = route[1];
    const id = decodeURIComponent(stripJson(route.slice(2).join('/')));
    return handleMeta(env, config, type, id, origin, ctx);
  }

  // Stream: stream/:type/:id.json
  if (head === 'stream' && route.length >= 3) {
    const config = decodeConfig(configStr);
    const type = route[1];
    const id = decodeURIComponent(stripJson(route.slice(2).join('/')));
    return handleStream(env, config, type, id, ctx);
  }

  // Configurator page (also reachable as /<config>/configure).
  if (head === 'configure') return assetResponse(env, request, '/configure.html');

  // API
  if (head === 'api') {
    if (route[1] === 'test-connection' && request.method === 'POST') return testConnection(request);
    return json({ ok: false, error: 'Unknown API route.' }, { status: 404 });
  }

  if (head === 'health') return json({ ok: true, version: '2.0.0' }, { cache: 'no-store' });

  // Everything else -> static configurator/landing assets.
  return assetResponse(env, request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err: any) {
      return json({ error: 'Internal error', detail: err?.message }, { status: 500 });
    }
  }
};
