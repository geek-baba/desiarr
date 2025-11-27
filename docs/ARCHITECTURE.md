# ARCHITECTURE

_Last refreshed: 2025-11-27_

## Purpose & Domain
- Radarr Indian Helper is a Node.js + TypeScript + Express dashboard that ingests RSS feeds, enriches them with TMDB/IMDB/Brave lookups, scores quality, and lets operators push curated releases into Radarr/Sonarr through a web UI.  
  - Source: `README.md L1-L210`
- The UI targets Indian-language movie & TV releases, exposing dashboards, data explorers, and manual controls (add/upgrade/ignore) for curators.  
  - Source: `README.md L33-L116`

## Runtime Topology
- **Backend**: Single Express process (`src/server.ts`) boots middleware, mounts routers, serves EJS views/static assets, and orchestrates startup/full sync + interval jobs (Radarr → Sonarr → RSS → matching engines).  
  - Source: `src/server.ts L1-L168`
- **Frontend**: Server-rendered EJS templates (`views/**`) with Tailwind CSS and a lightweight `public/js/ui.js` bundle for sidebar/dark-mode/sync polling UX.  
  - Source: `README.md L47-L50`, `views/dashboard.ejs`, `public/js/ui.js`
- **Background jobs**: In-process timers trigger Radarr/Sonarr/RSS syncs and periodic matching runs; manual Sync & Match hits the same pipeline via routes.  
  - Source: `src/server.ts L37-L152`, `src/routes/settings.ts L176-L200`
- **Persistence**: SQLite via `better-sqlite3`, configured through `src/db/index.ts`, emitted under `./data/app.db`.  
  - Source: `src/config.ts L5-L18`, `src/db/index.ts L1-L435`
- **External APIs**: Radarr/Sonarr clients for library sync + actions, TMDB/IMDB/Brave for metadata, TVDB for slug backfills.  
  - Source: `src/radarr/client.ts`, `src/sonarr/client.ts`, `src/services/rssSync.ts L1-L400`, `scripts/backfillTvdbSlugs.ts L1-L108`

## Data Layer
- **Schema**: `src/db/index.ts` bootstraps tables for feeds, RSS items, movie releases, TV releases, Radarr movies, Sonarr shows, app/quality settings, ignored shows, structured logs, plus indexes for guid/status lookups.  
  - Source: `src/db/index.ts L14-L335`, `src/db/index.ts L408-L434`
- **Models**: Thin wrappers in `src/models/*.ts` hydrate SQLite rows for feeds, releases, TV releases, settings, ignored shows, enabling transactional updates from routes/services.  
  - Source: `src/models/feeds.ts`, `src/models/releases.ts`, `src/models/tvReleases.ts`, `src/models/settings.ts`, `src/models/ignoredShows.ts`
- **Settings storage**: API credentials, sync cadences, and quality weights persist in `app_settings`, surfaced via `settingsModel`.  
  - Source: `src/models/settings.ts`, `src/routes/settings.ts L9-L200`
- **Quality rules**: `releasesModel` combines DB rows with computed scores; `qualityScore.ts` enforces allowlist/discouraged codecs, resolution weights, and upgrade thresholds referenced by the matching engines.  
  - Source: `src/scoring/qualityScore.ts`, `src/services/matchingEngine.ts L1-L210`

## Runtime/API Surface
- **Middleware**: JSON/urlencoded parsers and static assets; there is no authentication layer, so all routes are public within the network boundary.  
  - Source: `src/server.ts L17-L35`
- **Dashboards**: `src/routes/dashboard.ts` renders `/dashboard`, `/movies`, `/tv` with grouped releases, inline Radarr/Sonarr info, ignored-show controls, and sync triggers.  
  - Source: `src/routes/dashboard.ts L118-L400`
- **Data explorers**: `src/routes/data.ts` serves `/data/relea​ses`, `/data/tv-releases`, `/data/radarr`, `/data/rss`, `/data/logs`, plus helper JSON endpoints for sync stats and metadata backfills.  
  - Source: `src/routes/data.ts L1-L400`
- **Actions API**: `src/routes/actions.ts` exposes `POST /actions/:id/add|upgrade|ignore`, Radarr option lookups, Ignored-show toggles, and Sonarr helpers.  
  - Source: `src/routes/actions.ts L1-L200`
- **Settings API**: `src/routes/settings.ts` drives forms that CRUD feeds, update quality/app settings, and persist API credentials (Radarr/Sonarr/TMDB/OMDB/Brave/TVDB).  
  - Source: `src/routes/settings.ts L1-L400`
- **Logs API**: `src/routes/logs.ts` streams structured/in-memory logs for `/api/logs` and `/data/logs` tooling.  
  - Source: `src/routes/logs.ts`
- **Auth model**: No auth middleware exists; deploy behind VPN/reverse proxy if multi-tenant.  
  - Source: `src/server.ts L17-L35`
- **Critical middlewares/services**: `syncProgress` surfaces job state via `/actions` and dashboard polling; `logStorage` overrides console output to keep an in-memory buffer for UI rendering.  
  - Source: `src/services/syncProgress.ts L1-L75`, `src/services/logStorage.ts L1-L150`

## Data & Matching Pipelines
- **Radarr sync**: `syncRadarrMovies()` pulls the full Radarr library, upserts `radarr_movies`, and tracks stats + last sync time.  
  - Source: `src/services/radarrSync.ts L1-L315`
- **Sonarr sync**: `syncSonarrShows()` mirrors the TV library, enabling TV dashboards and release linking.  
  - Source: `src/services/sonarrSync.ts`
- **RSS ingest**: `syncRssFeeds()` iterates enabled feeds (movie & TV), parses releases, enriches IDs via TMDB/IMDB/Brave, and stores normalized rows in `rss_feed_items`.  
  - Source: `src/services/rssSync.ts L1-L400`
- **Matching engines**: `runMatchingEngine()` + `runTvMatchingEngine()` join RSS items with Radarr/Sonarr libraries, compute quality scores, categorize statuses (NEW, UPGRADE, ATTENTION_NEEDED, IGNORED), and persist into `movie_releases` / `tv_releases`.  
  - Source: `src/services/matchingEngine.ts L1-L210`, `src/services/tvMatchingEngine.ts`
- **Manual actions**: `releasesModel` updates statuses based on `/actions` responses (e.g., ADDED, IGNORED), keeping dashboards aligned with operator choices.  
  - Source: `src/routes/actions.ts L32-L200`, `src/models/releases.ts`

## Build & Deploy Flow
- **Local dev**: `npm install`, `npm run dev` (ts-node-dev) or `npm run build && npm start`.  
  - Source: `README.md L151-L178`, `package.json L1-L30`
- **Container**: Multi-stage Dockerfile installs build deps, runs `npm run build`, and boots `node dist/server.js` on port 8085.  
  - Source: `Dockerfile L1-L17`
- **CI/CD**: `.github/workflows/docker-build.yml` runs on pushes/PRs to `main`/`tv-integration`, builds multi-arch images via Buildx, pushes to GHCR, and forces `latest` visibility for default branch.  
  - Source: `.github/workflows/docker-build.yml L1-L70`
- **Deployment script**: `deploy.sh` waits on the latest GitHub Actions run for a branch, pulls `ghcr.io/geek-baba/desiarr:<branch|latest>`, restarts `docker run -p 8085:8085 -v data`.  
  - Source: `deploy.sh L1-L105`

## Non-Functional Traits
- **Structured logging**: Console overrides capture log lines and feed them into `structured_logs` with batching, sources, details, and error stacks.  
  - Source: `src/services/logStorage.ts L1-L150`, `src/services/structuredLogging.ts L1-L182`
- **Job telemetry**: `syncProgress` exposes `currentStep`, counts, and detail strings for dashboards/polling endpoints.  
  - Source: `src/services/syncProgress.ts L1-L75`
- **Rate limiting & fallbacks**: RSS sync tracks Brave API rate limiting (skipping further calls when 429) and validates TMDB/IMDB pairs before trusting metadata.  
  - Source: `src/services/rssSync.ts L37-L370`
- **Error handling**: Each sync route logs verbose context, pushes errors into `syncProgress`, and keeps pipelines running (e.g., Sonarr failures don't block movie sync).  
  - Source: `src/server.ts L43-L80`, `src/services/radarrSync.ts L28-L252`
- **Caching**: Synced Radarr/Sonarr tables behave as cache layers; read APIs pull from SQLite for determinism.  
  - Source: `src/services/radarrSync.ts L70-L213`, `src/services/sonarrSync.ts`
- **Feature toggles**: Feed records carry `enabled` + `feed_type`, letting the UI pause inputs without code changes.  
  - Source: `src/models/feeds.ts`, `src/routes/settings.ts L70-L140`

## Reading Guide
- **Application entrypoint & schedulers**: Start with `src/server.ts` to understand router wiring, static assets, and sync lifecycles.  
  - Source: `src/server.ts L1-L168`
- **Data ingestion**: `src/services/rssSync.ts` + `src/rss/parseRelease.ts` explain feed parsing, enrichment, and dedupe logic.  
  - Source: `src/services/rssSync.ts L1-L400`, `src/rss/parseRelease.ts`
- **Quality & scoring**: `src/scoring/parseFromTitle.ts` and `src/scoring/qualityScore.ts` highlight heuristics feeding the matching engines.  
  - Source: `src/scoring/parseFromTitle.ts`, `src/scoring/qualityScore.ts`
- **Matching & dashboards**: `src/services/matchingEngine.ts`, `src/services/tvMatchingEngine.ts`, and `src/routes/dashboard.ts` show how releases are grouped and rendered.  
  - Source: `src/services/matchingEngine.ts L1-L210`, `src/services/tvMatchingEngine.ts`, `src/routes/dashboard.ts L118-L400`
- **Manual operations**: `src/routes/actions.ts` plus `src/radarr/client.ts`/`src/sonarr/client.ts` explain how UI actions map to Radarr/Sonarr mutations.  
  - Source: `src/routes/actions.ts L1-L200`, `src/radarr/client.ts`, `src/sonarr/client.ts`
- **Observability**: `src/services/logStorage.ts`, `src/services/structuredLogging.ts`, and `src/routes/logs.ts` describe log capture + surfacing.  
  - Source: `src/services/logStorage.ts L1-L150`, `src/services/structuredLogging.ts L1-L182`, `src/routes/logs.ts`


