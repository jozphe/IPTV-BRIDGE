# IPTV Bridge — Cloudflare Worker

Edge rewrite of the IPTV Bridge Stremio/Nuvio addon. **Per-user model**: every
user brings their own Xtream/M3U credentials, compressed into their manifest URL
exactly like the original addon — there is no shared account and no server-side
storage of credentials.

```
https://<domain>/<compressed-config>/manifest.json
```

## What changed vs. the Vercel version

| Concern | Vercel (old) | Cloudflare Worker (new) |
| --- | --- | --- |
| Categories merging | 3 flat catalogs | 3 catalogs + IPTV categories as an `extra.genre` dropdown, filtered in memory |
| Slow movie search / TMDB on hot path | TMDB resolved live per request | TMDB cached **globally** at the edge (shared across all users) so a title is resolved once for everyone; catalogs use provider artwork and never call TMDB |
| Cold starts / single region | One Vercel region | Global Workers edge, no cold starts |
| Per-user provider data | Warm-instance memory (lost on cold start) | Cloudflare **Cache API**, cached per config fingerprint |
| Credentials | In the manifest URL | Unchanged — still in the manifest URL, never on the server |

Existing `iptvbridge.vercel.app/<config>/manifest.json` installs keep working:
the router splits the leading config segment from the addon route.

## Why Cache API instead of Workers KV

The original brief assumed a single shared panel + a Cron-refreshed KV index.
For **independent per-user credentials at ~1000 users that model does not fit**:
KV allows only ~1000 writes/day on the free tier, and a cron job cannot refresh
a thousand different panels. So this build uses the **Cloudflare Cache API**
(`caches.default`) instead, which has no write cap:

- **Per-user provider data** (`getItems`, genres) is cached per config
  fingerprint with a few-hour TTL. First request warms it; the rest are cache
  hits until TTL. Nobody sees anyone else's data (keys are namespaced by a hash
  of the credentials).
- **TMDB lookups** are cached with keys that deliberately **exclude the api
  key**, so all users share one global cache. The first user to open a title
  resolves it; everyone else gets the cached result. This is what removes TMDB
  from the per-request hot path.
- `Cache-Control` headers are also set so the Vercel CDN (which proxies the
  legacy domain) and clients cache responses on top of the Worker.

No KV namespace, no secrets, and no cron trigger are required.

## Endpoints

- `GET /<config>/manifest.json` (and `/manifest.json` → configuration-required manifest)
- `GET /<config>/catalog/:type/:id.json` and `/.../:extra.json` (`genre`, `skip`, `search`)
- `GET /<config>/meta/:type/:id.json`
- `GET /<config>/stream/:type/:id.json`  (`iptv:…`, `tt…`, `tmdb:…`)
- `GET /configure`, `/` and static assets (existing configurator UI via `ASSETS`)
- `POST /api/test-connection`, `GET /health`

A live catalog request = 1 edge-cache read + in-memory filter. Stream/meta for a
title do at most a couple of globally-cached TMDB calls, then match against the
user's cached provider list. Series episodes are fetched on demand from the
user's own Xtream account (playback data).

## Setup & deploy

```bash
cd worker
npm install
npm run typecheck
npm run deploy        # wrangler deploy
```

`wrangler.toml` needs no secrets. The only var is `TMDB_FALLBACK_KEY`, used when
a user did not enter their own TMDB key in the configurator.

## Migration / cutover

1. **Deploy the Worker.** `npm run deploy`; it comes up at
   `https://iptvbridge.<account>.workers.dev`.
2. **Test directly on the workers.dev URL.** Build a config in `/configure`,
   then open `/<config>/manifest.json`, a catalog (try the genre dropdown), a
   `/meta/...` and a `/stream/...`, and install it in Stremio/Nuvio to verify
   playback.
3. **Switch Vercel to proxy-only.** The repo-root `vercel.json` now contains
   only a CDN rewrite to the Worker — replace `<ACCOUNT-SUBDOMAIN>` with your
   real `workers.dev` subdomain (or a custom domain bound to the Worker), then
   redeploy the Vercel project. No serverless function is invoked, so no cold
   starts and no invocation caps.
4. **Verify the legacy domain.** `iptvbridge.vercel.app/<oldConfig>/manifest.json`
   should now serve the Worker unchanged — no user reinstalls.
5. **Remove old Vercel functions.** The old `api/` entry is already deleted; the
   `src/` (Express) tree is superseded by `worker/` and can be removed.

## Notes

- No Node-specific APIs (`fs`, `net`, `http`) — only `fetch`, `URL`, `atob`/`btoa`,
  Web Crypto-free FNV hashing, and `lz-string` for config decoding.
- Credentials never touch the server beyond the request that carries them, and
  are never logged.
