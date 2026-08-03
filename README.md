# IPTV Bridge

**Cinema for your Stremio & Nuvio.** Connect an Xtream Codes account or an M3U playlist and turn it into organized catalogs, global search, and automatic TMDB matching — every film and show resolves straight to your own IPTV sources.

Runs entirely **serverless** on the Vercel free tier. No database. No always-on server. Your credentials never leave the manifest link.

<p align="center">
  <img src="public/logo.svg" width="96" alt="IPTV Bridge logo" />
</p>

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Configuration model](#configuration-model)
- [Addon protocol endpoints](#addon-protocol-endpoints)
- [Local development](#local-development)
- [Deploying to Vercel](#deploying-to-vercel)
- [Installing in Stremio & Nuvio](#installing-in-stremio--nuvio)
- [Caching & performance](#caching--performance)
- [Privacy & security](#privacy--security)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

- **Two provider formats** — Xtream Codes API and plain M3U / M3U8 playlists.
- **Clean categories** — Live TV, Movies and Series sorted into tidy Stremio/Nuvio catalogs.
- **Global search** — search any title in the player; matching streams come from your own provider.
- **TMDB matching** — posters, ratings, years, and IMDB/TMDB ID resolution.
- **Fuzzy title matcher** — strips release tags/quality/season markers and ranks candidates with year and episode guards.
- **Stateless & free** — configuration is compressed into the manifest URL; the whole app is one Vercel serverless function.
- **Branded configurator** — an editorial, animated web UI (GSAP + canvas ember particles) to build and install your addon in three steps.

---

## How it works

```
Xtream / M3U  ─▶  Parse + Clean + Cache  ─▶  TMDB Resolver  ─▶  Fuzzy Matcher  ─▶  Stremio / Nuvio
```

1. **Connect** — you provide Xtream credentials or an M3U URL in the configurator. The addon parses channels, movies and series in a single pass and caches them on the warm serverless instance.
2. **Resolve** — when the player requests a title (by IMDB `tt…` or `tmdb:…` id), the TMDB resolver fetches canonical name/year, which is then cleaned and normalized.
3. **Stream** — the fuzzy matcher scores your IPTV items against the resolved title (with year/season/episode guards) and returns ranked, playable stream URLs.

---

## Architecture

**Runtime.** Node + TypeScript on Express, deployed as a single Vercel serverless function (`api/index.js` wraps the compiled Express app).

**State.** There is no database. Two mechanisms replace it:

- **Config in the URL** — the full user config (provider, credentials, TMDB key, category selection) is JSON-serialized and LZ-compressed into the manifest path segment.
- **Warm-instance TTL cache** — parsed playlists, Xtream stream lists and TMDB lookups are memoized in module-level memory with per-type TTLs, plus **in-flight de-duplication** so concurrent identical requests collapse into one upstream fetch.

**Matching.** A dedicated title cleaner removes country/quality/language tags and `SxxEyy` markers; `string-similarity` ranks candidates, penalizing year mismatches and filtering episodes.

**Protocol.** Implements the [Stremio v3 addon protocol](https://github.com/Stremio/stremio-addon-sdk) — `manifest`, `catalog`, `meta` and `stream` resources — which Nuvio also consumes.

### Request flow

```
        ┌──────────────────────── Vercel Serverless Function ────────────────────────┐
        │                                                                             │
Client ─┼─▶ Express router                                                            │
        │     ├─ GET /                         → public/index.html (landing)          │
        │     ├─ GET /configure                → public/configure.html (wizard)       │
        │     ├─ POST /api/test-connection     → live provider + TMDB validation      │
        │     ├─ GET /:config/manifest.json    → getManifest(decodeConfig)            │
        │     ├─ GET /:config/catalog/...json  → handleCatalog ─┐                      │
        │     ├─ GET /:config/meta/...json      → handleMeta    ├─▶ provider + TMDB    │
        │     └─ GET /:config/stream/...json    → handleStream ─┘   (via TTL cache)    │
        │                                                                             │
        └─────────────────────────────────────────────────────────────────────────────┘
                        │                         │                    │
                        ▼                         ▼                    ▼
                 Xtream Codes API           M3U playlist          TMDB API
```

---

## Project structure

```
.
├── api/
│   └── index.js                # Vercel entrypoint — exports the compiled Express app
├── public/                     # Static, served as-is
│   ├── index.html              # Landing page (full project details)
│   ├── configure.html          # 3-step build wizard
│   ├── theme.css               # Shared design system (editorial/ember theme)
│   ├── theme.js                # Ember particle field, custom cursor, magnetic buttons
│   ├── logo.svg                # Brand mark
│   └── favicon.svg
├── src/
│   ├── server.ts               # Express app + all route wiring
│   ├── addon.ts                # Stremio protocol: manifest, catalog, meta, stream handlers
│   ├── types/
│   │   └── index.ts            # Shared TS types (config, IPTV items, Stremio shapes)
│   ├── utils/
│   │   ├── config.ts           # LZ-String encode/decode of user config
│   │   └── cache.ts            # TTL cache + in-flight de-duplication
│   ├── iptv/
│   │   ├── provider.ts         # Unified, cached IPTV fetch layer (Xtream + M3U)
│   │   ├── xtream.ts           # Xtream Codes API client
│   │   ├── m3u.ts              # M3U / M3U8 parser
│   │   └── cleaner.ts          # Title normalization (tags, quality, SxxEyy, year)
│   ├── tmdb/
│   │   ├── tmdb.ts             # TMDB client (find by IMDB, by TMDB id, search)
│   │   └── matcher.ts          # Fuzzy title matching → ranked Stremio streams
│   └── api/
│       └── testConnection.ts   # POST /api/test-connection handler
├── vercel.json                 # Routes all traffic to the serverless function
├── tsconfig.json
└── package.json
```

---

## Configuration model

The configurator builds a `UserConfig` object and compresses it into the manifest URL:

```ts
interface UserConfig {
  type: 'xtream' | 'm3u';
  host?: string;          // Xtream server URL
  username?: string;      // Xtream username
  password?: string;      // Xtream password
  m3uUrl?: string;        // M3U playlist URL
  tmdbApiKey?: string;    // TMDB v3 API key (recommended)
  includedCategories?: string[];
  includeLive?: boolean;
  includeMovies?: boolean;
  includeSeries?: boolean;
  streamType?: 'm3u8' | 'ts' | 'auto';
}
```

Encoding uses `lz-string`'s URL-safe compression, so the resulting manifest is:

```
https://<your-app>.vercel.app/<compressed-config>/manifest.json
```

---

## Addon protocol endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Landing page |
| `GET` | `/configure` | Build wizard |
| `POST` | `/api/test-connection` | Validate provider + TMDB key, return categories |
| `GET` | `/:config/manifest.json` | Addon manifest (catalogs, types, resources) |
| `GET` | `/:config/catalog/:type/:id.json` | Browse a catalog (supports `search=`, `genre=`) |
| `GET` | `/:config/meta/:type/:id.json` | Metadata for an item (TMDB-enriched) |
| `GET` | `/:config/stream/:type/:id.json` | Resolve playable IPTV streams for a title |

`:type` is one of `tv`, `movie`, `series`. IDs may be IMDB (`tt…`), TMDB (`tmdb:…`) or internal (`iptv:…`).

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (ts-node-dev, hot reload)
npm run dev
# → http://localhost:7000

# 3. Build for production (TypeScript → dist/)
npm run build
```

Open `http://localhost:7000` for the landing page and `http://localhost:7000/configure` for the wizard.

---

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import it in [Vercel](https://vercel.com/new).
3. Vercel runs `vercel-build` (`tsc`) automatically and routes all traffic to `api/index.js` per `vercel.json`.
4. Visit your deployment and open `/configure` to generate your manifest.

No environment variables are required — the TMDB key (optional) is entered per-user in the configurator and encoded into the manifest link.

---

## Installing in Stremio & Nuvio

- **Stremio (one click):** the wizard produces a `stremio://…/manifest.json` link — click **Install to Stremio**.
- **Stremio Web / Nuvio:** copy the `https://…/manifest.json` URL and paste it into the add-addon field.

---

## Caching & performance

- **TTLs:** categories 30 min · streams 10 min · playlist parse 15 min · TMDB 24 h.
- **De-duplication:** simultaneous identical requests share a single in-flight promise.
- **Single-parse M3U:** one playlist download is reused across catalog, meta and stream requests via a provider fingerprint key.
- **Bounded memory:** the cache evicts expired and oldest entries past a cap so warm instances stay lean.

---

## Privacy & security

- Credentials are **never stored server-side** — they live only inside the LZ-compressed manifest URL you generate and hold.
- Treat your manifest URL like a password: anyone with it can use your IPTV subscription.
- The public web configurator validates connections in the browser-initiated `POST /api/test-connection`; nothing is persisted.

---

## Roadmap

- EPG / TV guide support for live channels.
- Series episode drill-down via Xtream `get_series_info`.
- Optional per-quality stream splitting in the matcher.
- Genre catalogs mapped from TMDB genres.

---

## License

MIT. See [`LICENSE`](LICENSE). This project is a technical bridge; you are responsible for the legality of any IPTV source you connect.
