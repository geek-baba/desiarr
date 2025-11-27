# CONTRIBUTING

_Operational playbook for desiarr — updated 2025-11-27_

## Local Development
- Use Node.js 22+ with npm; install deps via `npm install` then run `npm run dev` for ts-node-dev or `npm run build && npm start` for compiled runs.  
  - Source: `README.md L151-L178`, `package.json L1-L30`
- Environment variables are limited to infrastructure concerns (`PORT`, `RADARR_API_URL`, `RADARR_API_KEY`, `DB_PATH`), while runtime credentials live in SQLite via the Settings UI.  
  - Source: `src/config.ts L5-L18`, `README.md L126-L148`
- SQLite database files live in `./data`; schema + default quality/app settings auto-seed at boot, so no manual migration step is needed.  
  - Source: `src/db/index.ts L6-L406`

## Tooling Commands
- **Typecheck/build**: `npm run build` invokes `tsc` and doubles as the TypeScript typecheck gate.  
  - Source: `package.json L6-L13`
- **Dev server**: `npm run dev` starts `ts-node-dev --respawn --transpile-only src/server.ts`.  
  - Source: `package.json L6-L13`
- **Lint/tests**: No npm scripts exist yet; add `npm run lint` / `npm test` before shipping new frameworks.  
  - Source: `package.json L1-L30`

## Database & Seeding
- Bootstrapping the app creates `movie_releases`, `tv_releases`, `rss_feed_items`, `radarr_movies`, `sonarr_shows`, `app_settings`, `structured_logs`, and `ignored_shows` tables, plus default quality/app settings JSON blobs.  
  - Source: `src/db/index.ts L14-L435`
- If you need sample data, run the manual sync pipeline (`/settings/refresh` or CLI) to populate RSS + release tables instead of crafting fixtures by hand.  
  - Source: `src/routes/settings.ts L176-L200`, `src/services/rssSync.ts L26-L400`

## Branching & Commit Rules
- Branch from `main` for production fixes/enhancements and from `tv-integration` when iterating on TV features; hotfix PRs target the same branch they branched from.  
  - Source: `docs/REFERENCE.md L9-L24`
- Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, etc.) so CI and release tooling can parse intent.  
  - Source: `docs/REFERENCE.md L9-L24`

## PR Expectations
- Include summary, before/after evidence for UI changes, impacted files, testing notes (manual + automated), risk analysis, and rollback instructions.  
  - Source: `docs/REFERENCE.md L15-L43`
- Run `npm run build` locally before pushing; CI builds Docker images on `main`/`tv-integration`, so failing builds block deployments.  
  - Source: `package.json L6-L10`, `.github/workflows/docker-build.yml L1-L70`


