# Deployment Instructions

## Docker Deployment Command

Use this command to deploy the radarr-indian-helper container:

```bash
docker run -d \
  --name radarr-indian-helper \
  -p 8085:8085 \
  -e RADARR_API_URL=http://10.10.10.20:7880/api/v3 \
  -e RADARR_API_KEY=8131da6e33fe4aac86806fa2fafe7466 \
  -v "/Users/shwet/my_daily_chore:/app/data" \
  ghcr.io/geek-baba/radarr-indian-helper:latest
```

## Useful Commands

### View Logs
```bash
docker logs -f radarr-indian-helper
```

### Stop Container
```bash
docker stop radarr-indian-helper
```

### Remove Container (keeps data)
```bash
docker rm radarr-indian-helper
```

### Restart Container
```bash
docker restart radarr-indian-helper
```

### Pull Latest Image
```bash
docker pull ghcr.io/geek-baba/radarr-indian-helper:latest
```

### Update to Latest Image
```bash
docker stop radarr-indian-helper
docker rm radarr-indian-helper
docker pull ghcr.io/geek-baba/radarr-indian-helper:latest
# Then run the deployment command above
```

## Data Persistence

The database and all settings are stored in the mounted volume: `/Users/shwet/my_daily_chore`

This directory contains:
- `app.db` - SQLite database with all releases, feeds, and settings
- Any other application data

## Access

- Dashboard: http://localhost:8085
- Settings: http://localhost:8085/settings

