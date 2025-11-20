import { Router, Request, Response } from 'express';
import { feedsModel } from '../models/feeds';
import { settingsModel } from '../models/settings';
import { QualitySettings } from '../types/QualitySettings';
import { backfillRadarrLinks } from '../tasks/backfillRadarr';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const feeds = feedsModel.getAll();
    const qualitySettings = settingsModel.getQualitySettings();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value || '';
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value || '';
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value || '';
    const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key')?.value || '';

    res.render('settings', {
      feeds,
      qualitySettings,
      tmdbApiKey,
      omdbApiKey,
      radarrApiUrl,
      radarrApiKey,
    });
  } catch (error) {
    console.error('Settings page error:', error);
    res.status(500).send('Internal server error');
  }
});

router.get('/feeds/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const feed = feedsModel.getById(id);
    
    if (!feed) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    res.json({ success: true, feed });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

router.post('/feeds', async (req: Request, res: Response) => {
  try {
    const { name, url, enabled } = req.body;
    
    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    const feed = feedsModel.create({
      name,
      url,
      enabled: enabled === 'true' || enabled === true,
    });

    res.json({ success: true, feed });
  } catch (error) {
    console.error('Create feed error:', error);
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

router.put('/feeds/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, url, enabled } = req.body;

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (url !== undefined) updates.url = url;
    if (enabled !== undefined) {
      updates.enabled = typeof enabled === 'string' 
        ? (enabled === 'true' || enabled === '1') 
        : Boolean(enabled);
    }

    const feed = feedsModel.update(id, updates);

    if (!feed) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    res.json({ success: true, feed });
  } catch (error) {
    console.error('Update feed error:', error);
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

router.delete('/feeds/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const success = feedsModel.delete(id);

    if (!success) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete feed error:', error);
    res.status(500).json({ error: 'Failed to delete feed' });
  }
});

router.post('/quality', async (req: Request, res: Response) => {
  try {
    const settings: QualitySettings = req.body;
    
    // Validate required fields
    if (!settings.resolutions || !settings.resolutionWeights) {
      return res.status(400).json({ error: 'Invalid quality settings' });
    }

    settingsModel.setQualitySettings(settings);
    res.json({ success: true });
  } catch (error) {
    console.error('Update quality settings error:', error);
    res.status(500).json({ error: 'Failed to update quality settings' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    // Import sync services
    const { syncRadarrMovies } = await import('../services/radarrSync');
    const { syncRssFeeds } = await import('../services/rssSync');
    const { runMatchingEngine } = await import('../services/matchingEngine');

    // Run full sync cycle in background
    (async () => {
      try {
        console.log('Manual sync triggered from UI');
        await syncRadarrMovies();
        await syncRssFeeds();
        await runMatchingEngine();
        console.log('Manual sync completed');
      } catch (error) {
        console.error('Manual sync error:', error);
      }
    })();

    res.json({ success: true, message: 'Full sync cycle started (Radarr → RSS → Matching)' });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Failed to start refresh' });
  }
});

router.get('/refresh/stats', (req: Request, res: Response) => {
  try {
    // Refresh stats are no longer used with the new sync architecture
    // Return empty stats for backward compatibility
    res.json({ success: true, stats: { isRunning: false, currentFeed: null, feedsProcessed: 0, totalFeeds: 0 } });
  } catch (error) {
    console.error('Get refresh stats error:', error);
    res.status(500).json({ error: 'Failed to get refresh stats' });
  }
});

router.post('/tmdb-api-key', (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    settingsModel.set('tmdb_api_key', apiKey || '');
    res.json({ success: true });
  } catch (error) {
    console.error('Save TMDB API key error:', error);
    res.status(500).json({ error: 'Failed to save TMDB API key' });
  }
});

router.post('/omdb-api-key', (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    settingsModel.set('omdb_api_key', apiKey || '');
    res.json({ success: true });
  } catch (error) {
    console.error('Save OMDB API key error:', error);
    res.status(500).json({ error: 'Failed to save OMDB API key' });
  }
});

router.post('/radarr-config', async (req: Request, res: Response) => {
  try {
    const { apiUrl, apiKey } = req.body;
    
    console.log('Saving Radarr config - URL:', apiUrl ? 'Provided' : 'Missing', 'Key:', apiKey ? 'Provided' : 'Missing');
    
    if (!apiUrl || !apiKey) {
      console.error('Radarr config validation failed: Missing URL or Key');
      return res.status(400).json({ success: false, error: 'Radarr API URL and Key are required' });
    }

    // Trim whitespace
    const trimmedUrl = apiUrl.trim();
    const trimmedKey = apiKey.trim();

    // Validate URL format
    try {
      new URL(trimmedUrl);
    } catch (error) {
      console.error('Radarr config validation failed: Invalid URL format', trimmedUrl);
      return res.status(400).json({ success: false, error: 'Invalid Radarr API URL format' });
    }

    console.log('Saving Radarr config to database...');
    settingsModel.set('radarr_api_url', trimmedUrl);
    settingsModel.set('radarr_api_key', trimmedKey);
    console.log('Radarr config saved to database successfully');

    // Verify it was saved
    const allSettings = settingsModel.getAll();
    const savedUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value;
    const savedKey = allSettings.find(s => s.key === 'radarr_api_key')?.value;
    
    if (savedUrl !== trimmedUrl || savedKey !== trimmedKey) {
      console.error('Radarr config verification failed: Values do not match');
      return res.status(500).json({ success: false, error: 'Configuration was not saved correctly. Please try again.' });
    }

    // Update Radarr client configuration
    console.log('Updating Radarr client configuration...');
    const radarrClient = (await import('../radarr/client')).default;
    radarrClient.updateConfig();
    console.log('Radarr client configuration updated');

    res.json({ success: true, message: 'Radarr configuration saved successfully' });
  } catch (error: any) {
    console.error('Save Radarr config error:', error);
    res.status(500).json({ success: false, error: 'Failed to save Radarr configuration: ' + (error?.message || 'Unknown error') });
  }
});

router.post('/maintenance/backfill-radarr', async (_req: Request, res: Response) => {
  try {
    const summary = await backfillRadarrLinks();
    res.json({ success: true, summary });
  } catch (error) {
    console.error('Backfill Radarr links error:', error);
    res.status(500).json({ error: 'Failed to backfill Radarr links' });
  }
});

export default router;

