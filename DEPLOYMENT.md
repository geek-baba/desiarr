# Deployment Guide

## Quick Deploy Script

A deployment script is available at `deploy.sh` that automatically:
1. Checks the latest GitHub Actions run
2. Waits for it to complete if in progress
3. Deploys the latest image if the run succeeded

### Usage

```bash
./deploy.sh
```

### Manual Deployment

If you prefer to deploy manually:

```bash
# Stop and remove existing container
docker stop desiarr
docker rm desiarr

# Pull latest image (choose :latest, :main, :tv-integration, etc.)
docker pull ghcr.io/geek-baba/desiarr:latest

# Run new container
docker run -d \
  --name desiarr \
  -p 8085:8085 \
  -v "/Users/shwet/my_daily_chore:/app/data" \
  ghcr.io/geek-baba/desiarr:latest
```
> After the container starts, visit `/settings` to enter Radarr/Sonarr/TMDB/OMDB/Brave/TVDB credentials and RSS feeds. These values are stored in SQLite and no longer passed via environment variables.

## Automatic Deployment

### Option 1: Run Script After Each Push

After pushing to GitHub, run:
```bash
./deploy.sh
```

### Option 2: Set Up a Cron Job (macOS)

To automatically check and deploy every 5 minutes:

```bash
# Edit crontab
crontab -e

# Add this line (adjust path as needed)
*/5 * * * * cd /Users/shwet/github/desiarr && ./deploy.sh >> /tmp/radarr-deploy.log 2>&1
```

### Option 3: GitHub Actions Webhook (Advanced)

For true automatic deployment, you can set up a webhook that triggers on successful workflow completion. This requires:
1. A webhook endpoint (e.g., using a simple HTTP server)
2. GitHub webhook configuration
3. The webhook calls the deploy script

## Monitoring

Check container status:
```bash
docker ps --filter name=desiarr
```

View logs:
```bash
docker logs -f desiarr
```

## Troubleshooting

If deployment fails:
1. Check GitHub Actions status: `gh run list --limit 1`
2. Check container logs: `docker logs desiarr`
3. Verify image exists: `docker images ghcr.io/geek-baba/desiarr:latest`
4. Review branch/version context in `docs/REFERENCE.md`
