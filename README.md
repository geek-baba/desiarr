# Radarr Indian Helper

Internal dashboard for orchestrating Indian-language **movie and TV** releases with Radarr/Sonarr by combining RSS feeds, TMDB/TVDB metadata, custom quality scoring, and one-click automation. See `docs/REFERENCE.md` for the latest release, branch, and deployment context.

## Table of Contents
- [Overview](#overview)
- [Feature Highlights](#feature-highlights)
- [System Architecture](#system-architecture)
  - [Tech Stack](#tech-stack)
  - [Data Flow](#data-flow)
  - [Key Modules](#key-modules)
- [Data Model](#data-model)
- [Background Jobs & Sync Pipeline](#background-jobs--sync-pipeline)
- [UI Pages & Routes](#ui-pages--routes)
- [External Integrations](#external-integrations)
- [Configuration](#configuration)
  - [Radarr API Setup](#radarr-api-setup)
  - [RSS Feeds](#rss-feeds)
  - [Quality & Matching Rules](#quality--matching-rules)
  - [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Docker](#docker)
- [Deployment Workflow](#deployment-workflow)
- [Logging & Troubleshooting](#logging--troubleshooting)
- [License](#license)

## Overview

Radarr Indian Helper is a Node.js + TypeScript + Express application with an EJS/Tailwind UI. It continuously ingests multiple RSS feeds, enriches releases with TMDB/IMDB data, evaluates them against custom quality rules, and surfaces actionable insights (new movies, upgrades, manual fixes) for Radarr users. A single “Sync & Match” control or background scheduler keeps Radarr, RSS, and release data aligned.

## Feature Highlights

- **Insightful dashboards**: Movies (`/movies`) and TV (`/tv`) views group new releases, upgrade candidates, attention-needed items, ignored titles, and stats. Global search, tabbed filters, dark mode, and sticky headers keep navigation fast.
- **Flattened Releases view**: Dedicated `/data/releases` page lists every release with poster art, TMDB/IMDB IDs, quality metadata, actions (Add/Upgrade/Ignore), and exportable links.
- **Radarr/Sonarr & RSS data explorers**: `/data/radarr`, `/data/tv-releases`, and `/data/rss` expose synced library metadata and raw feed items with parsed tags for debugging matching issues.
- **One-click Sync & Match**: Triggers a full Radarr/Sonarr sync → RSS sync → movie and TV matching-engine passes. Inline progress shows per-step metrics (e.g., “3 new movies from Radarr”, “2 RSS updates”), includes granular log lines, reloads automatically on success, and surfaces dismissible errors with guidance.
- **Smart matching engines**: Movie and TV pipelines normalize RSS titles, score quality attributes, detect dubbed content, enforce size deltas, and enrich releases with TMDB/TVDB posters and identifiers for later rendering.
- **Manual actions with guardrails**: Add, upgrade, or ignore releases directly from the UI via `/actions` endpoints. TMDB ID is required (Radarr constraint), but releases can be added regardless of their status (NEW / ATTENTION_NEEDED / IGNORED).
- **Comprehensive Settings UI**: Manage Radarr credentials, feed definitions, and quality rules (weights, preferred languages, dubbed penalties, upgrade thresholds) with instant validation. All settings live in SQLite, not env vars.
- **App-level controls**: Dedicated “Connections” and “App Settings” tabs let you manage API credentials, sync cadences (Radarr/Sonarr/RSS), and dashboard auto-refresh intervals without editing env vars.
- **Structured logging & log explorer**: Persistent `structured_logs` table plus `/data/logs` and `/api/logs` endpoints enable timeline filtering, severity breakdowns, and deep dives without shell access.
- **Global search & keyboard shortcuts**: Cmd/Ctrl+K focuses the search bar. Dashboard search filters cards client-side; data pages leverage server-side queries.
- **Responsive shell & dark mode**: Tailwind-based layout adapts to mobile/desktop, with saved dark/light preference and mobile-friendly sidebar controls.

## System Architecture

### Tech Stack
- **Runtime**: Node.js 22+, TypeScript, Express.
- **Rendering**: EJS templates with Tailwind CSS; vanilla JS in `public/js/ui.js`.
- **Data**: SQLite via better-sqlite3 with write-ahead logging (WAL) for durability.
- **Background services**: In-process cron-style intervals plus on-demand jobs.
- **Containerization**: Multi-arch Docker image (`ghcr.io/geek-baba/desiarr`).

### Data Flow
```
Radarr API -> syncRadarrMovies() -> radarr_movies table
Sonarr API -> syncSonarrShows()  -> sonarr_shows table
Movie RSS  -> syncRssFeeds(movie) -> rss_feed_items -> matchingEngine()  -> movie_releases
TV RSS     -> syncRssFeeds(tv)    -> tvMatchingEngine()                  -> tv_releases
                                                |
                                                v
                                       Dashboards & Data Pages
```
`syncProgress` tracks the state of manual “Sync & Match” jobs, while `structuredLogging` captures diagnostics through every stage.

### Key Modules
- `src/server.ts`: Express bootstrap, static assets, router mounting, startup sync + schedule orchestration.
- `src/routes/`: HTTP handlers for dashboards (`/movies`, `/tv`), data explorers, actions, settings, logs, and refresh-stat endpoints.
- `src/services/`:
  - `radarrSync.ts`: Radarr movie ingestion, quality profile lookup, library caching.
  - `rssSync.ts`: Feed polling, release parsing, Brave/TMDB/IMDB enrichment, duplicate handling.
  - `matchingEngine.ts`: Core matching/scoring engine, TMDB poster extraction, Radarr history merging.
  - `tvMatchingEngine.ts`: TV-specific enrichment pipeline with Sonarr awareness.
  - `syncProgress.ts`: In-memory progress + detail lines for long-running jobs.
  - `structuredLogging.ts` & `logStorage.ts`: Centralized logging helpers and pruning.
- `src/models/`: lightweight repo layer for feeds, releases, settings.
- `src/tmdb`, `src/imdb`, `src/brave`, `src/radarr`: API clients and type adapters.
- `views/`: EJS templates for movie & TV dashboards and supporting pages; `partials/` share shell, header, sidebar, and card components.
- `public/js/ui.js`: Handles dark mode, sidebar controls, global search wiring, icon rendering, timestamp formatting, copy-to-clipboard, and Sync & Match polling UI.

## Data Model
SQLite schema (see `src/db/index.ts`) includes:
- `rss_feeds`: UI-managed feed configs (name, URL, enabled flag, timestamps).
- `rss_feed_items`: Raw feed snapshots with normalized titles, parsed tags, manual override flags, and sync timestamps.
- `radarr_movies`: Cached Radarr library (TMDB/IMDB IDs, language, images, file info, `synced_at`).
- `releases`: Canonical release records powering the UI; stores TMDB poster URL, normalized metadata, scoring fields, Radarr linkage, and status (`NEW`, `UPGRADE`, `ATTENTION_NEEDED`, `IGNORED`).
- `app_settings`: JSON blobs for quality rules, sync intervals, and Radarr credentials.
- `structured_logs`: Persistent log storage with severity, source, job_id, and optional stack traces.

## Background Jobs & Sync Pipeline
- **Initial boot**: `runFullSyncCycle()` executes Radarr sync → RSS sync → matching engine before the server starts listening.
- **Scheduled intervals** (configurable via settings):
  - Radarr sync every `radarrSyncIntervalHours` (default 6h).
  - RSS sync every `rssSyncIntervalHours` (default 1h) with immediate matching engine pass.
  - Matching engine also runs every 30 minutes to reevaluate existing data.
- **Manual Sync & Match** (`POST /build-match`):
  1. Runs all three steps sequentially in the background.
  2. `GET /build-match/progress` exposes {status, step, percent, details[]} for polling.
  3. UI shows progress, new/updated counts, and errors with actionable copy.
- **Rate limiting & resiliency**:
  - Brave Search 429s short-circuit additional Brave calls for the current sync yet keep the job alive.
  - TMDB/Radarr/IMDB failures bubble up to syncProgress and structured logs.

## UI Pages & Routes
| Route | Purpose |
| --- | --- |
| `/movies` | Movies dashboard with summary cards, stats, Sync & Match control, and grouped release tables. |
| `/tv` | TV dashboard highlighting new shows, seasons, and attention-needed items. |
| `/data/releases` | Flattened movie releases list with posters, metadata, actions, and global search. |
| `/data/radarr` | View cached Radarr library, quality profiles, root folders, and sync timestamps. |
| `/data/tv-releases` | Inspect normalized TV releases, Sonarr linkage, and manual actions. |
| `/data/rss` | Inspect RSS feeds, raw items, parsed tags, and manual ID overrides. |
| `/settings` | Manage Radarr API credentials, RSS feeds, quality preferences, and sync intervals. |
| `/actions/*` | POST endpoints for add/upgrade/ignore operations tied to UI buttons. |
| `/api/logs` & `/data/logs` | Structured log API + UI explorer with filters and live stream. |

Shared header (`views/partials/app-header.ejs`) injects global search, dark-mode toggle, and “Last refreshed” timestamps on every primary page.

## External Integrations
- **Radarr API** (`src/radarr/client.ts`): Library sync, movie lookup/add, search queue triggers, quality profile and root folder reads.
- **Sonarr API** (`src/sonarr/client.ts`): Show sync, series lookup/add, and status detection.
- **TMDB API** (`src/tmdb/client.ts`): Title search, metadata retrieval, poster paths for releases (stored as full URLs).
- **IMDB/OMDB & Brave Search** (`src/imdb`, `src/brave`): Backup ID resolution when TMDB lacks results; Brave rate limiting handled gracefully.
- **RSS feeds** (`src/services/rssSync.ts`): Parser-based ingestion with per-feed enablement and normalized metadata extraction.

## Configuration

### Radarr API Setup
1. Obtain Radarr API key (Radarr → Settings → General → Security).
2. Visit `/settings` → “Radarr API Configuration”.
3. Provide the Radarr API URL (`http(s)://host:port/api/v3`) and API key.
4. Save to persist in SQLite (survives container restarts). Environment variables are no longer used for these credentials.

### RSS Feeds
1. Go to `/settings` → “RSS Feeds”.
2. Add feed name + URL, toggle enabled flag, and reorder as needed.
3. Changes take effect on the next RSS sync or manual Sync & Match.

### Quality & Matching Rules
Located under `/settings`:
- Allowed resolutions per codec (2160p/1080p/720p/480p/UNKNOWN) with preferred/discouraged codecs.
- Weight maps for resolution, source tags (AMZN/NF/JC/ZEE5/DSNP/HS/SS/OTHER), codecs, and audio formats (Atmos/TrueHD/DDP5.1/DD5.1/2.0).
- Language handling: preferred audio languages, bonus points, dubbed penalties.
- Upgrade heuristics: min size delta %, score delta threshold, optional size-bonus toggle.
- Sync cadence: Radarr and RSS interval sliders (hours).
All values serialize to JSON inside `app_settings`.

### Environment Variables
Only `PORT`, `DB_PATH`, and other infrastructure concerns are read in `src/config.ts`. Radarr/Sonarr/TMDB/OMDB/Brave/TVDB credentials, feed definitions, and quality rules are stored in SQLite via the Settings UI.

## Local Development

### Prerequisites
- Node.js 22+
- npm

### Setup
1. Install dependencies
   ```bash
   npm install
   ```
2. (Optional) set the port
   ```bash
   export PORT=8085
   ```
3. Build TypeScript
   ```bash
   npm run build
   ```
4. Start the server
   ```bash
   npm start
   ```
5. Visit `http://localhost:8085` and configure Radarr + feeds from `/settings`.

Hot-reload/workflow tips:
- `npm run dev` (if defined) can be wired to ts-node-dev/nodemon.
- SQLite database lives under `./data` (configurable).

## Docker

### Build Locally
```bash
docker build -t desiarr .
docker run -p 8085:8085 -v /path/to/data:/app/data desiarr
```

### Quick Start with GHCR Image
```bash
docker pull ghcr.io/geek-baba/desiarr:latest

docker run -d \
  --name desiarr \
  -p 8085:8085 \
  -v /path/to/data:/app/data \
  ghcr.io/geek-baba/desiarr:latest
```
Then browse to `http://localhost:8085/settings` to enter Radarr credentials and feeds.

## Deployment Workflow
- GitHub Actions workflow `Build and Push Docker Image` builds multi-arch images on every `main` push and publishes to GHCR.
- `deploy.sh` pulls the freshly tagged `latest`, stops the running container, redeploys, and reminds operators that Radarr config lives in the UI.
- Default container listens on port 8085; adjust host port mapping as desired.

## Logging & Troubleshooting
- Structured logs stored in SQLite power `/data/logs` and the real-time `/api/logs` endpoint. Filter by level, source, or job ID to investigate sync issues.
- Sync progress UI surfaces user-facing errors; raw stack traces and API responses are captured in `structured_logs`.
- Brave Search rate limits emit `BRAVE_RATE_LIMITED` warnings; TMDB/Radarr errors show both in progress UI and logs.
- RSS and Radarr data explorers provide ground truth when matching results differ from expectations.

## License

ISC
