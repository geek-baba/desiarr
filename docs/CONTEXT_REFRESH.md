# CONTEXT REFRESH

_Keeps repo context docs evergreen — updated 2025-11-27_

## Usage
1. Install dependencies (`npm install`) if not already done.  
   - Source: `README.md L151-L169`
2. Run `npm run context:refresh` from the repo root.  
   - Source: `package.json L6-L15`

## What the Script Does
- Rebuilds the folder tree + SLOC sections inside `docs/repo-map.md`, stamping the refresh time.  
  - Source: `scripts/contextRefresh.js L83-L142`
- Updates the `_Last refreshed` line in `docs/CODE-NAV.md` to reflect the run timestamp.  
  - Source: `scripts/contextRefresh.js L144-L149`
- Validates all relative Markdown links under `docs/` plus `README.md`, failing (non-zero exit) if any targets are missing.  
  - Source: `scripts/contextRefresh.js L151-L192`

## Troubleshooting
- Ensure `scripts/contextRefresh.js` is executable or run via `node scripts/contextRefresh.js`.  
  - Source: `scripts/contextRefresh.js L1-L8`
- The script ignores `node_modules`, `.git`, and `dist` when generating trees/SLOC; add directories there if needed to reduce noise.  
  - Source: `scripts/contextRefresh.js L20-L30`, `scripts/contextRefresh.js L44-L63`


