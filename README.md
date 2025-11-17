# Radarr Indian Helper

Internal web dashboard for managing Indian-language movie releases with Radarr.

## Setup

1. Install dependencies: `npm install`
2. Set environment variables:
   - `PORT` (default: 8085)
   - `RADARR_API_URL`
   - `RADARR_API_KEY`
3. Build: `npm run build`
4. Start: `npm start`

## Docker

```bash
docker build -t radarr-indian-helper .
docker run -p 8085:8085 -e RADARR_API_URL=... -e RADARR_API_KEY=... radarr-indian-helper
```

