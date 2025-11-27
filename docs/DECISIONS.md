# DECISIONS

_Architecture decision log – updated 2025-11-27_

## 2025-11-27 — Express + EJS Monolith
- **Context**: Need a fast UI for Radarr/Sonarr operators without introducing a separate SPA build pipeline.
- **Decision**: Keep a single Node.js/Express runtime with EJS views, Tailwind (CDN), and static JS for interactivity.
- **Consequences**: Server-side rendering keeps deploys simple but concentrates logic in large route/view files; consider modularizing before major UI rewrites.
- **Refs**: `README.md L27-L210`, `src/server.ts L1-L35`, `views/dashboard.ejs`, `public/js/ui.js`

## 2025-11-27 — SQLite Config Store
- **Context**: Operators must change API credentials, feed lists, and quality weights without redeploying.
- **Decision**: Persist all user-facing settings (feeds, API keys, cadences, quality rules) in SQLite via the Settings UI; only infrastructure env vars stay in `.env`.
- **Consequences**: Enables runtime edits and keeps secrets off env files, but adds DB migrations on boot and requires volume persistence in Docker deployments.
- **Refs**: `README.md L126-L148`, `src/routes/settings.ts L9-L200`, `src/db/index.ts L94-L406`

## 2025-11-27 — Structured Logging via Console Override
- **Context**: Need end-user log explorer without external services.
- **Decision**: Override `console.*`, buffer logs, and flush structured rows into SQLite while still printing to stdout.
- **Consequences**: Guarantees UI parity with server logs but risks double-wrapping if `logStorage` is imported twice; keep import centralized and monitor DB size.
- **Refs**: `src/services/logStorage.ts L1-L150`, `src/services/structuredLogging.ts L1-L182`, `views/log-explorer.ejs`, `src/routes/logs.ts L1-L200`

## 2025-11-27 — Full Sync Pipeline Order
- **Context**: Matching accuracy depends on up-to-date Radarr/Sonarr caches before processing RSS releases.
- **Decision**: Every full sync (manual or scheduled) runs Radarr → Sonarr → RSS → movie matching → TV matching, with retries logged but non-blocking failures.
- **Consequences**: Ensures cached metadata is fresh for scoring but makes sync latency cumulative; watch long-running Sonarr syncs so they don't delay RSS ingest.
- **Refs**: `src/server.ts L37-L168`, `src/services/radarrSync.ts L17-L252`, `src/services/rssSync.ts L26-L400`, `src/services/tvMatchingEngine.ts`

## 2025-11-27 — Keep Release Categories Separate
- **Context**: Debated whether to flatten Add/Upgrade/Ignored releases into a single view.
- **Decision**: Retain separate categories and color-coded sections per release type for clarity, even when rendered within unified tables.
- **Consequences**: UI stays aligned with operator mental models but increases template complexity; future filtering must respect per-category semantics.
- **Refs**: `docs/archive/PHASE2_DECISIONS.md L3-L188`, `views/dashboard.ejs`, `src/routes/dashboard.ts L170-L304`


