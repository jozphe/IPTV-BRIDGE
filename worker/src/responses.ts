// Response helpers: CORS + JSON + edge cache headers.
//
// Cache-Control matters twice here: it lets the Vercel CDN (which proxies the
// legacy iptvbridge.vercel.app domain) cache addon responses at the edge, and
// it lets Stremio/Nuvio clients avoid hammering the Worker.

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export interface JsonOpts {
  status?: number;
  cache?: string;
}

export function json(data: unknown, opts: JsonOpts = {}): Response {
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8'
  };
  headers['Cache-Control'] = opts.cache || 'no-store';
  return new Response(JSON.stringify(data), { status: opts.status || 200, headers });
}

// Sensible edge cache windows per resource.
export const CACHE = {
  manifest: 'public, max-age=600, stale-while-revalidate=1800',
  catalog: 'public, max-age=300, stale-while-revalidate=900',
  meta: 'public, max-age=1800, stale-while-revalidate=3600',
  stream: 'public, max-age=60, stale-while-revalidate=300'
};
