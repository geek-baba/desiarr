import express from 'express';
import path from 'path';
import { config } from './config';
import dashboardRouter from './routes/dashboard';
import actionsRouter from './routes/actions';
import settingsRouter from './routes/settings';
import { fetchAndProcessFeeds } from './rss/fetchFeeds';
import { settingsModel } from './models/settings';

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/', dashboardRouter);
app.use('/actions', actionsRouter);
app.use('/settings', settingsRouter);

// Start periodic refresh
let refreshInterval: NodeJS.Timeout | null = null;

function startPeriodicRefresh() {
  const settings = settingsModel.getQualitySettings();
  const intervalMs = settings.pollIntervalMinutes * 60 * 1000;

  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  refreshInterval = setInterval(() => {
    console.log('Running periodic feed refresh...');
    fetchAndProcessFeeds().catch((error) => {
      console.error('Periodic refresh error:', error);
    });
  }, intervalMs);

  console.log(`Periodic refresh started with interval: ${settings.pollIntervalMinutes} minutes`);
}

// Initial refresh on startup
console.log('Starting initial feed refresh...');
fetchAndProcessFeeds()
  .then(() => {
    startPeriodicRefresh();
  })
  .catch((error) => {
    console.error('Initial refresh error:', error);
    startPeriodicRefresh(); // Start periodic refresh anyway
  });

const port = config.port;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

