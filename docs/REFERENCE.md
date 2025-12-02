## desiarr Reference Guide

### Current Snapshot (Nov 2025)
- Node 22 + Express + TypeScript + EJS app with Tailwind (CDN) UI.
- Movies pipeline: Radarr sync → RSS ingest → `matchingEngine` → `/movies` dashboard and `/data/releases`.
- TV pipeline (tv-integration branch): Sonarr sync → TV RSS ingest → `tvMatchingEngine` → `/tv` dashboard and `/data/tv-releases`.
- Structured logs, sync progress polling, and Settings UI live in SQLite (`app_settings`, `structured_logs`, etc.).

### Branch & Version Strategy
- `main`: Staging branch with both movie + TV pipelines; tagged `v2.1.0` (Docker: `ghcr.io/geek-baba/desiarr:2.1.0` and `:latest`).
- `tv-integration`: Historical development branch for TV features (now merged); keep future enhancements on short-lived feature/fix branches.
- Feature hotfixes should branch from the appropriate base (`main` for production issues, feature branches for ongoing work), then PR into `main`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.) to keep CI automation predictable.

### Deployment Workflow
- Preferred: push to GitHub → GitHub Actions builds multi-arch GHCR image (tagged by branch) → run `./deploy.sh [branch]`.
  - Script waits for the latest workflow run, pulls `ghcr.io/geek-baba/desiarr:<branch|latest>`, stops container, and runs with `-v /path/to/data:/app/data`.
  - Credentials (Radarr/Sonarr/TMDB/etc.) are **not** set via env vars; configure them through `/settings` after deploy.
- Manual fallback:
  ```bash
  docker pull ghcr.io/geek-baba/desiarr:<tag>
  docker stop desiarr && docker rm desiarr
  docker run -d --name desiarr -p 8085:8085 -v /path/to/data:/app/data ghcr.io/geek-baba/desiarr:<tag>
  ```

### Configuration Model
- `PORT`, `DB_PATH`, and optional paths remain env-driven for the process.
- All user-level settings (Radarr/Sonarr endpoints, API keys, feed definitions, quality weights, sync cadences) persist in SQLite via the Settings UI. Service clients read from `app_settings` on each call (`settingsModel` + per-client cache refresh).
- The new “App Settings” tab groups sync cadences (Radarr/Sonarr/RSS) and dashboard auto-refresh; set the refresh interval to `0` to disable periodic reloads.

### UI & Routes Overview
- `/movies`: Tabbed dashboard (New, Existing, Unmatched) with Sync & Match control.
- `/tv`: Parallel dashboard grouping NEW_SHOW/NEW_SEASON/Existing/Unmatched, plus Sonarr-aware metadata.
- `/data/releases`, `/data/radarr`, `/data/rss`, `/data/tv-releases`, `/data/logs`: Explorer views.
- `/settings`: Manage credentials, RSS feeds (movie/tv feed_type), quality rules, sync cadences.
- `/actions/*`: Add/upgrade/ignore endpoints for movies (TV actions pending; tracked below).

### Open Items / Backlog
- TV releases page still lacks inline “Add to Sonarr” / “Ignore” wiring (currently only “View” links).
- Dashboard filter drawer, chip search, keyboard shortcuts, and Tailwind build pipeline remain planned enhancements (see archived docs for design notes).
- Consider migrating from Tailwind CDN to compiled CSS before v2.0 if size/perf becomes a concern.

### PR Expectations
- Every PR must include a summary, before/after evidence for UI work, impacted files list, manual + automated test notes, risk analysis, and a rollback plan.
- Run `npm run build` (typecheck) and the future lint/test suites before requesting review so the Docker build workflow on `main`/`tv-integration` stays green.

Use this document as the single source of truth; historical planning artifacts now live in `docs/archive/`.

