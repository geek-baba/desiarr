# CODE NAVIGATION

_Last refreshed: 2025-11-27 13:33:40 UTC_

## Module Index

### 1. Dashboards & Views
- **Problem it solves**: Surfaces combined movie/TV dashboards, grouped releases, sync controls, and ignored-show tooling in one UI.
- **Where to start**: `src/routes/dashboard.ts` for data shaping, `views/dashboard.ejs` + `views/partials/**` for rendering, `public/js/ui.js` for client interactivity.
- **Key types/components**: `Release` (`src/types/Release.ts`), `tvReleasesModel`, `parseFromTitle` for enrichment, dashboard partials for cards/tables.
- **Pitfalls / tech debt**: Route file >1.4k LOC with duplicated logic between `/dashboard`, `/movies`, `/tv`; consider extracting helpers before new filters.
- Sources: `src/routes/dashboard.ts L1-L400`, `views/dashboard.ejs`, `public/js/ui.js`, `src/types/Release.ts`

### 2. RSS Ingestion
- **Problem it solves**: Polls RSS feeds, normalizes release metadata, enriches IDs through TMDB/IMDB/Brave, and persists to `rss_feed_items`.
- **Where to start**: `src/services/rssSync.ts`, `src/rss/parseRelease.ts`, `src/models/feeds.ts`.
- **Key types/components**: `Parser` pipeline, `parseRSSItem`, API clients (`tmdb`, `imdb`, `brave`), `feedsModel` toggles, `syncProgress`.
- **Pitfalls**: Brave API throttling handled via a boolean; if rate limit triggered mid-run, remaining items skip Brave enrichment—monitor logs before assuming missing IDs.
- Sources: `src/services/rssSync.ts L1-L400`, `src/rss/parseRelease.ts`, `src/models/feeds.ts`

### 3. Matching Engines
- **Problem it solves**: Joins RSS items with Radarr library data to classify releases (NEW/UPGRADE/IGNORED) and compute quality scores.
- **Where to start**: `src/services/matchingEngine.ts`, `src/services/tvMatchingEngine.ts`, `src/scoring/qualityScore.ts`, `src/scoring/parseFromTitle.ts`.
- **Key types/components**: `Release` schema, `settingsModel.getQualitySettings()`, `computeQualityScore`, `isReleaseAllowed`.
- **Pitfalls**: Matching runs rely on cached Radarr records; if caches are stale, `getSyncedRadarrMovieByTmdbId` may miss links—ensure `syncRadarrMovies()` ran recently before debugging missing matches.
- Sources: `src/services/matchingEngine.ts L1-L210`, `src/services/tvMatchingEngine.ts`, `src/scoring/qualityScore.ts`, `src/scoring/parseFromTitle.ts`

### 4. Radarr & Sonarr Sync
- **Problem it solves**: Mirrors external libraries into SQLite for offline queries and matching.
- **Where to start**: `src/services/radarrSync.ts`, `src/services/sonarrSync.ts`, `src/radarr/client.ts`, `src/sonarr/client.ts`.
- **Key types/components**: `RadarrMovie` types, `radarr_movies` / `sonarr_shows` tables, sync stats + `syncProgress`.
- **Pitfalls**: Sync loops wrap DB operations in transactions; any schema drift or unexpected Radarr payloads will fail mid-transaction. Check stats/errors arrays in logs, not just HTTP responses.
- Sources: `src/services/radarrSync.ts L1-L315`, `src/services/sonarrSync.ts`, `src/radarr/client.ts`, `src/sonarr/client.ts`

### 5. Settings & Credentials
- **Problem it solves**: Manages feed definitions, quality/app settings, and API credentials stored in SQLite instead of env vars.
- **Where to start**: `src/routes/settings.ts`, `views/settings.ejs`, `src/models/settings.ts`.
- **Key types/components**: `QualitySettings`, `AppSettings`, feed CRUD endpoints, credential POST handlers for TMDB/OMDB/Brave/Radarr/Sonarr/TVDB.
- **Pitfalls**: The route logs sensitive data (first 10 chars of keys); redact before enabling multi-tenant deployments.
- Sources: `src/routes/settings.ts L1-L400`, `views/settings.ejs`, `src/models/settings.ts`, `src/types/QualitySettings.ts`

### 6. Manual Actions & API Integrations
- **Problem it solves**: Exposes `/actions/*` endpoints to add/upgrade/ignore releases in Radarr/Sonarr.
- **Where to start**: `src/routes/actions.ts`, `src/radarr/client.ts`, `src/sonarr/client.ts`.
- **Key types/components**: Add/upgrade flows, Radarr quality profiles/root folders, `ignoredShowsModel`, TMDB lookups for missing IDs.
- **Pitfalls**: Actions trust release metadata; ensure matching engine populates `tmdb_id` before calling `/add` or endpoints will 400. Path conflicts bubble up from Radarr—error handling already inspects `MoviePathValidator`.
- Sources: `src/routes/actions.ts L1-L200`, `src/models/ignoredShows.ts`, `src/radarr/client.ts`

### 7. Logging & Diagnostics
- **Problem it solves**: Captures structured logs and exposes them via `/api/logs` and UI explorers.
- **Where to start**: `src/services/logStorage.ts`, `src/services/structuredLogging.ts`, `src/routes/logs.ts`, `views/log-explorer.ejs`.
- **Key types/components**: Console overrides, log buffer flush, structured log schema, filtering/pagination route, log explorer view.
- **Pitfalls**: `logStorage` overrides console globally; importing it twice can double-wrap logs. Ensure `import './services/logStorage'` happens only once (already done in `src/server.ts`).
- Sources: `src/services/logStorage.ts L1-L150`, `src/services/structuredLogging.ts L1-L182`, `src/routes/logs.ts L1-L200`

### 8. Database Schema & Migrations
- **Problem it solves**: Keeps SQLite schema up to date and seeds default quality/app settings.
- **Where to start**: `src/db/index.ts`.
- **Key types/components**: Table definitions, migration checks (`PRAGMA table_info`), default settings inserts, column backfills.
- **Pitfalls**: The file performs ALTER TABLE operations on startup; running multiple instances simultaneously could race. Ensure single-writer deployments.
- Sources: `src/db/index.ts L14-L435`

## Bug-Tracing Checklist
1. **Identify the surface**: Map the failing route/page to its router (`src/routes/**`) and view partial—use the sections above to jump in.  
   - Source: `src/server.ts L24-L35`
2. **Check sync state**: Hit `/actions/progress` (via dashboard polling) or inspect `syncProgress` to verify long-running jobs.  
   - Source: `src/services/syncProgress.ts L1-L75`, `src/routes/dashboard.ts L128-L400`
3. **Review structured logs**: Query `/api/logs?source=<area>` or the `structured_logs` table for WARN/ERROR entries tied to your timeframe.  
   - Source: `src/routes/logs.ts L18-L200`, `src/services/structuredLogging.ts L1-L182`
4. **Validate cached data**: Use `/data/radarr`, `/data/rss`, `/data/tv-releases` to ensure SQLite mirrors external systems before changing business logic.  
   - Source: `src/routes/data.ts L54-L200`
5. **Re-run pipeline**: Trigger manual sync via `/settings/refresh` or CLI (call `syncRadarrMovies`, `syncRssFeeds`, `runMatchingEngine`) to reproduce with verbose logs.  
   - Source: `src/routes/settings.ts L176-L200`, `src/services/radarrSync.ts L17-L252`
6. **Confirm external API creds**: Settings route prints which keys are loaded; mismatches often cause empty data rather than hard errors.  
   - Source: `src/routes/settings.ts L9-L50`


