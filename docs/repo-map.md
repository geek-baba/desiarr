# Repo Map

_Last refreshed: 2025-11-27 13:33:40 UTC_

## Folder Tree (depth 3)
```
.
├── data
│   ├── app.db
│   ├── app.db-shm
│   └── app.db-wal
├── docs
│   ├── archive
│   │   ├── PHASE_STATUS.md
│   │   ├── PHASE1_REVIEW.md
│   │   ├── PHASE2_DECISIONS.md
│   │   ├── PHASE2_REVIEW.md
│   │   ├── SEARCH_AUDIT.md
│   │   └── UI_REFACTOR_ANALYSIS.md
│   ├── ARCHITECTURE.md
│   ├── CODE-NAV.md
│   ├── CONTEXT_REFRESH.md
│   ├── CONTRIBUTING.md
│   ├── DECISIONS.md
│   ├── REFERENCE.md
│   └── repo-map.md
├── public
│   ├── assets
│   │   └── desiarr-logo.svg
│   ├── css
│   │   └── app.css
│   └── js
│       └── ui.js
├── scripts
│   ├── backfillTvdbSlugs.ts
│   └── contextRefresh.js
├── src
│   ├── brave
│   │   └── client.ts
│   ├── db
│   │   └── index.ts
│   ├── imdb
│   │   └── client.ts
│   ├── models
│   │   ├── feeds.ts
│   │   ├── ignoredShows.ts
│   │   ├── releases.ts
│   │   ├── settings.ts
│   │   └── tvReleases.ts
│   ├── radarr
│   │   ├── client.ts
│   │   └── types.ts
│   ├── routes
│   │   ├── actions.ts
│   │   ├── dashboard.ts
│   │   ├── data.ts
│   │   ├── logs.ts
│   │   ├── refreshStats.ts
│   │   └── settings.ts
│   ├── rss
│   │   └── parseRelease.ts
│   ├── scoring
│   │   ├── parseFromTitle.ts
│   │   └── qualityScore.ts
│   ├── services
│   │   ├── logStorage.ts
│   │   ├── matchingEngine.ts
│   │   ├── radarrSync.ts
│   │   ├── rssSync.ts
│   │   ├── sonarrSync.ts
│   │   ├── structuredLogging.ts
│   │   ├── syncProgress.ts
│   │   ├── tvdbSlugBackfill.ts
│   │   └── tvMatchingEngine.ts
│   ├── sonarr
│   │   └── client.ts
│   ├── tasks
│   │   └── backfillRadarr.ts
│   ├── tmdb
│   │   └── client.ts
│   ├── tvdb
│   │   └── client.ts
│   ├── types
│   │   ├── QualitySettings.ts
│   │   └── Release.ts
│   ├── utils
│   │   └── codecMapping.ts
│   ├── config.ts
│   └── server.ts
├── views
│   ├── partials
│   │   ├── dashboard
│   │   ├── app-header.ejs
│   │   ├── app-shell.ejs
│   │   ├── app-sidebar.ejs
│   │   ├── dark-mode-toggle.ejs
│   │   ├── logo-desiarr.ejs
│   │   ├── movie-card.ejs
│   │   └── sidebar.ejs
│   ├── dashboard.ejs
│   ├── layout.ejs
│   ├── log-explorer.ejs
│   ├── logs.ejs
│   ├── radarr-data.ejs
│   ├── releases-list.ejs
│   ├── rss-data.ejs
│   ├── settings.ejs
│   ├── sonarr-data.ejs
│   └── tv-releases-list.ejs
├── deploy.sh
├── DEPLOYMENT.md
├── Dockerfile
├── package.json
├── README.md
├── tailwind.config.js
└── tsconfig.json
```
- Source: auto-generated via npm run context:refresh (2025-11-27 13:33:40 UTC)

## SLOC by Top Modules
| Module / directory | Total LOC |
| --- | --- |
| `views` | 8,135 |
| `src/routes` | 4,872 |
| `src/services` | 3,497 |
| `src/models` | 625 |
| `src/db` | 437 |
| `public` | 404 |
| `src/radarr` | 355 |
| `scripts` | 300 |
- Source: auto-generated via npm run context:refresh (2025-11-27 13:33:40 UTC)

## Environment Variables & Status
- `PORT` (defaults to `8085`) – Express listen port.
  - Source: `src/config.ts L1-L18`
- `RADARR_API_URL`, `RADARR_API_KEY` – still read at process boot for backwards compatibility but the UI now stores credentials in SQLite.
  - Source: `src/config.ts L5-L18`
- `DB_PATH` (defaults to `./data/app.db`) – storage location for SQLite.
  - Source: `src/config.ts L11-L18`
- Missing `.env.example`: repository root does not ship a template enumerating the variables above; add one so onboarding is deterministic.
  - Source: repo tree (27 Nov 2025)
- Quick validation: server logs warn if Radarr env vars are absent, indicating the runtime still expects them when the UI store is empty.
  - Source: `src/config.ts L16-L18`

## Services, Scripts, and Tooling
- npm scripts:
  - `dev`: ts-node-dev hot reload entrypoint.
  - `build`: `tsc` compilation step.
  - `start`: runs the compiled server from `dist/server.js`.
  - Source: `package.json L1-L30`
- Deployment:
  - Dockerfile uses Node 22 alpine, installs build deps for `better-sqlite3`, runs `npm install`, `npm run build`, exposes 8085, and starts `node dist/server.js`.
    - Source: `Dockerfile L1-L17`
  - GitHub Actions workflow (`.github/workflows/docker-build.yml`) builds/pushes multi-arch images on `main` + `tv-integration`, tags `latest` on default branch, and forces public visibility post-push.
    - Source: `.github/workflows/docker-build.yml L1-L70`
  - `deploy.sh` waits for the latest successful workflow run for a branch, pulls `ghcr.io/geek-baba/desiarr:<tag>`, restarts the local container, mounts `/app/data`, and reminds operators to use the Settings UI for credentials.
    - Source: `deploy.sh L1-L105`
- Utility scripts:
  - `scripts/backfillTvdbSlugs.ts` focuses on TVDB slug population for shows missing metadata.
    - Source: `scripts/backfillTvdbSlugs.ts`

## Quick Wins & Signals
- **Env template gap**: add `.env.example` covering `PORT`, `DB_PATH`, `RADARR_API_URL`, `RADARR_API_KEY` so Phase 8 validation can spot drifts automatically.
  - Source: `src/config.ts L1-L18`, repo tree
- **Test coverage**: no `test` script is defined, so CI cannot assert regressions; introduce even smoke tests plus `npm run test`.
  - Source: `package.json L1-L30`
- **Hotspots to watch in PRs**:
  - `src/routes/dashboard.ts` (1,433 LOC) – monolithic route powering movies dashboard; split into presenters + data loaders before further features.
    - Source: `npx cloc src --by-file --csv --quiet`
  - `src/routes/data.ts` (1,201 LOC) – data explorer endpoints share SQL fragments inline; risk of regressions when adding filters.
    - Source: `npx cloc src --by-file --csv --quiet`
  - `src/services/rssSync.ts` (947 LOC) – feed ingestion + normalization + duplication checks; high churn when adding new feeds.
    - Source: `npx cloc src --by-file --csv --quiet`
  - `views/dashboard.ejs` (1,769 LOC) – UI complexity makes diff reviews noisy; consider splitting into partials per section.
    - Source: `npx cloc views --by-file --csv --quiet`
  - `views/settings.ejs` (1,138 LOC) – houses multiple forms; extracting components would reduce merge conflicts.
    - Source: `npx cloc views --by-file --csv --quiet`
- **Tests & flakiness**: automated tests are absent, so failing/flaky suites cannot be listed yet; treat this as a blocker for shipping risky work.
  - Source: `package.json L1-L30`


