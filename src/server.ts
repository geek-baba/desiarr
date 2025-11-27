import express from 'express';
import path from 'path';
import { config } from './config';
import dashboardRouter from './routes/dashboard';
import actionsRouter from './routes/actions';
import settingsRouter from './routes/settings';
import dataRouter from './routes/data';
import logsRouter from './routes/logs';
import { settingsModel } from './models/settings';
import { syncRadarrMovies } from './services/radarrSync';
import { syncSonarrShows } from './services/sonarrSync';
import { syncRssFeeds } from './services/rssSync';
import { runMatchingEngine } from './services/matchingEngine';
import { runTvMatchingEngine } from './services/tvMatchingEngine';
import './services/logStorage'; // Initialize log storage

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/', dashboardRouter);
app.use('/actions', actionsRouter);
app.use('/settings', settingsRouter);
app.use('/data', dataRouter);
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

