import express from 'express';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import dashboardRouter from './routes/dashboard';
import actionsRouter from './routes/actions';
import settingsRouter from './routes/settings';
import dataRouter from './routes/data';
import tmdbDataRouter from './routes/tmdbData';
import dataHygieneRouter from './routes/dataHygiene';
import logsRouter from './routes/logs';
import { settingsModel } from './models/settings';
import { syncRadarrMovies } from './services/radarrSync';
import { syncSonarrShows } from './services/sonarrSync';
import { syncRssFeeds } from './services/rssSync';
import { runMatchingEngine } from './services/matchingEngine';
import { runTvMatchingEngine } from './services/tvMatchingEngine';
import { incrementalTmdbSync } from './services/tmdbSync';
import db from './db';
import './services/logStorage'; // Initialize log storage

const app = express();

// Expose app version to all views from package.json
let appVersion = '0.0.0';
try {
  const packageJsonPath = path.join(__dirname, '../package.json');
  const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonRaw);
  if (typeof packageJson.version === 'string') {
    appVersion = packageJson.version;
  }
} catch (error) {
  console.error('Failed to read app version from package.json:', error);
}
app.locals.appVersion = appVersion;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Make appVersion available to all templates via res.locals
app.use((req, res, next) => {
  res.locals.appVersion = app.locals.appVersion;
  next();
});

app.use('/', dashboardRouter);
app.use('/actions', actionsRouter);
app.use('/settings', settingsRouter);
app.use('/data', dataRouter);
app.use('/tmdb-data', tmdbDataRouter);
app.use('/data-hygiene', dataHygieneRouter);
app.use('/api/logs', logsRouter);

// Redirect /logs to /data/logs for convenience
app.get('/logs', (req, res) => {
  res.redirect('/data/logs');
});

// Scheduled sync jobs
let radarrSyncInterval: NodeJS.Timeout | null = null;
let sonarrSyncInterval: NodeJS.Timeout | null = null;
let rssSyncInterval: NodeJS.Timeout | null = null;
let matchingInterval: NodeJS.Timeout | null = null;
let tmdbSyncInterval: NodeJS.Timeout | null = null;

async function runFullSyncCycle() {
  try {
    console.log('=== Starting full sync cycle ===');
    
    // Step 1: Sync Radarr movies
    console.log('Step 1: Syncing Radarr movies...');
    await syncRadarrMovies();
    
    // Step 2: Sync Sonarr shows
    console.log('Step 2: Syncing Sonarr shows...');
    try {
      await syncSonarrShows();
    } catch (error) {
      console.error('Sonarr sync error (continuing):', error);
      // Continue even if Sonarr sync fails
    }
    
    // Step 3: Sync RSS feeds (both movie and TV)
    console.log('Step 3: Syncing RSS feeds...');
    await syncRssFeeds();
    
    // Step 4: Run movie matching engine
    console.log('Step 4: Running movie matching engine...');
    await runMatchingEngine();
    
    // Step 5: Run TV matching engine
    console.log('Step 5: Running TV matching engine...');
    try {
      await runTvMatchingEngine();
    } catch (error) {
      console.error('TV matching engine error (continuing):', error);
      // Continue even if TV matching fails
    }
    
    console.log('=== Full sync cycle completed ===');
  } catch (error) {
    console.error('Full sync cycle error:', error);
  }
}

function startScheduledSyncs() {
  const appSettings = settingsModel.getAppSettings();
  
  // Clear existing intervals
  if (radarrSyncInterval) clearInterval(radarrSyncInterval);
  if (sonarrSyncInterval) clearInterval(sonarrSyncInterval);
  if (rssSyncInterval) clearInterval(rssSyncInterval);
  if (matchingInterval) clearInterval(matchingInterval);
  if (tmdbSyncInterval) clearInterval(tmdbSyncInterval);

  // Radarr sync interval
  const radarrIntervalMs = (appSettings.radarrSyncIntervalHours || 6) * 60 * 60 * 1000;
  radarrSyncInterval = setInterval(async () => {
    console.log('Running scheduled Radarr sync...');
    try {
      await syncRadarrMovies();
    } catch (error) {
      console.error('Scheduled Radarr sync error:', error);
    }
  }, radarrIntervalMs);
  console.log(`Radarr sync scheduled every ${appSettings.radarrSyncIntervalHours || 6} hours`);

  // Sonarr sync interval
  const sonarrIntervalMs = (appSettings.sonarrSyncIntervalHours || 6) * 60 * 60 * 1000;
  sonarrSyncInterval = setInterval(async () => {
    console.log('Running scheduled Sonarr sync...');
    try {
      await syncSonarrShows();
    } catch (error) {
      console.error('Scheduled Sonarr sync error:', error);
    }
  }, sonarrIntervalMs);
  console.log(`Sonarr sync scheduled every ${appSettings.sonarrSyncIntervalHours || 6} hours`);

  // RSS sync interval
  const rssIntervalMs = (appSettings.rssSyncIntervalHours || 1) * 60 * 60 * 1000;
  rssSyncInterval = setInterval(async () => {
    console.log('Running scheduled RSS sync...');
    try {
      await syncRssFeeds();
      // After RSS sync, run both matching engines
      await runMatchingEngine();
      try {
        await runTvMatchingEngine();
      } catch (error) {
        console.error('Scheduled TV matching engine error:', error);
      }
    } catch (error) {
      console.error('Scheduled RSS sync error:', error);
    }
  }, rssIntervalMs);
  console.log(`RSS sync scheduled every ${appSettings.rssSyncIntervalHours || 1} hours`);

  // Matching engine runs after RSS sync, but also run it periodically
  // (it will use the latest synced data)
  const matchingIntervalMs = 30 * 60 * 1000; // Every 30 minutes
  matchingInterval = setInterval(async () => {
    console.log('Running scheduled matching engines...');
    try {
      await runMatchingEngine();
      try {
        await runTvMatchingEngine();
      } catch (error) {
        console.error('Scheduled TV matching engine error:', error);
      }
    } catch (error) {
      console.error('Scheduled matching engine error:', error);
    }
  }, matchingIntervalMs);
  console.log('Matching engines scheduled every 30 minutes');

  // TMDB sync: Check every hour, sync at 2 AM or if >24 hours since last sync
  const tmdbCheckIntervalMs = 60 * 60 * 1000; // Every hour
  tmdbSyncInterval = setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    
    // Check if it's 2 AM (or check if >24 hours since last sync)
    const lastSyncSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('tmdb_last_sync_date') as { value: string } | undefined;
    const lastSyncDate = lastSyncSetting?.value || null;
    
    let shouldSync = false;
    
    if (hour === 2) {
      // It's 2 AM - sync
      shouldSync = true;
    } else if (lastSyncDate) {
      // Check if >24 hours since last sync
      const lastSync = new Date(lastSyncDate);
      const hoursSinceSync = (now.getTime() - lastSync.getTime()) / (1000 * 60 * 60);
      if (hoursSinceSync >= 24) {
        shouldSync = true;
      }
    } else {
      // Never synced - do initial sync (but only once per day to avoid spam)
      const lastAttempt = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('tmdb_last_attempt_date') as { value: string } | undefined;
      if (!lastAttempt || lastAttempt.value !== now.toISOString().split('T')[0]) {
        shouldSync = true;
        // Record attempt date
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('tmdb_last_attempt_date', now.toISOString().split('T')[0]);
      }
    }
    
    if (shouldSync) {
      console.log('Running scheduled TMDB incremental sync...');
      try {
        await incrementalTmdbSync();
      } catch (error) {
        console.error('Scheduled TMDB sync error:', error);
      }
    }
  }, tmdbCheckIntervalMs);
  console.log('TMDB sync scheduled to check every hour (syncs at 2 AM or if >24h since last sync)');
}

// Initial sync on startup
console.log('Starting initial sync cycle...');
runFullSyncCycle()
  .then(() => {
    startScheduledSyncs();
  })
  .catch((error) => {
    console.error('Initial sync error:', error);
    startScheduledSyncs(); // Start scheduled syncs anyway
  });

const port = config.port;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

