import { Router, Request, Response } from 'express';
import { feedsModel } from '../models/feeds';
import { settingsModel } from '../models/settings';
import { AppSettings, QualitySettings } from '../types/QualitySettings';
import { backfillRadarrLinks } from '../tasks/backfillRadarr';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const feeds = feedsModel.getAll();
    const qualitySettings = settingsModel.getQualitySettings();
    const appSettings = settingsModel.getAppSettings();
    const allSettings = settingsModel.getAll();
    
    console.log('=== Loading Settings Page ===');
    console.log('Total settings:', allSettings.length);
    console.log('Settings keys:', allSettings.map(s => s.key).join(', '));
    
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value || '';
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value || '';
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key')?.value || '';
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value || '';
    const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key')?.value || '';
    const sonarrApiUrl = allSettings.find(s => s.key === 'sonarr_api_url')?.value || '';
    const sonarrApiKey = allSettings.find(s => s.key === 'sonarr_api_key')?.value || '';
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value || '';
    const tvdbUserPin = allSettings.find(s => s.key === 'tvdb_user_pin')?.value || '';
    
    console.log('Radarr URL found:', radarrApiUrl ? 'Yes' : 'No');
    console.log('Radarr Key found:', radarrApiKey ? 'Yes' : 'No');
    console.log('Sonarr URL found:', sonarrApiUrl ? 'Yes' : 'No');
    console.log('Sonarr Key found:', sonarrApiKey ? 'Yes' : 'No');
    console.log('Database path:', process.env.DB_PATH || './data/app.db');

    res.render('settings', {
      feeds,
      qualitySettings,
      appSettings,
      tmdbApiKey,
      omdbApiKey,
      braveApiKey,
      radarrApiUrl,
      radarrApiKey,
      sonarrApiUrl,
      sonarrApiKey,
      tvdbApiKey,
      tvdbUserPin,
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
    const { name, url, enabled, feed_type } = req.body;
    
    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    const feedType = feed_type === 'tv' ? 'tv' : 'movie'; // Default to 'movie' if not specified

    const feed = feedsModel.create({
      name,
      url,
      enabled: enabled === 'true' || enabled === true,
      feed_type: feedType,
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
    const { name, url, enabled, feed_type } = req.body;

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (url !== undefined) updates.url = url;
    if (enabled !== undefined) {
      updates.enabled = typeof enabled === 'string' 
        ? (enabled === 'true' || enabled === '1') 
        : Boolean(enabled);
    }
    if (feed_type !== undefined) {
      updates.feed_type = feed_type === 'tv' ? 'tv' : 'movie';
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

router.post('/app-settings', async (req: Request, res: Response) => {
  try {
    const payload: Partial<AppSettings> = req.body;
    const appSettings: AppSettings = {
      pollIntervalMinutes: Math.max(0, parseInt(String(payload.pollIntervalMinutes ?? 60), 10) || 0),
      radarrSyncIntervalHours: Math.max(1, parseFloat(String(payload.radarrSyncIntervalHours ?? 6)) || 1),
      sonarrSyncIntervalHours: Math.max(1, parseFloat(String(payload.sonarrSyncIntervalHours ?? 6)) || 1),
      rssSyncIntervalHours: Math.max(0.25, parseFloat(String(payload.rssSyncIntervalHours ?? 1)) || 1),
    };
    settingsModel.setAppSettings(appSettings);
    res.json({ success: true });
  } catch (error) {
    console.error('Update app settings error:', error);
    res.status(500).json({ error: 'Failed to update app settings' });
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

router.post('/tmdb-api-key', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    
    console.log('=== Saving TMDB API Key ===');
    console.log('Received API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'Missing');
    console.log('Database path:', process.env.DB_PATH || './data/app.db');
    
    // Trim whitespace
    const trimmedKey = (apiKey || '').trim();
    
    console.log('Saving to database...');
    settingsModel.set('tmdb_api_key', trimmedKey);
    
    console.log('Settings saved. Verifying...');
    
    // Immediately verify it was saved
    const allSettings = settingsModel.getAll();
    console.log('Total settings in database:', allSettings.length);
    
    const savedKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    
    console.log('Saved Key:', savedKey ? `${savedKey.substring(0, 10)}...` : 'NOT FOUND');
    
    if (savedKey !== trimmedKey) {
      console.error('ERROR: Saved value does not match input value!');
      console.error('Expected:', trimmedKey);
      console.error('Got:', savedKey);
      return res.status(500).json({ 
        success: false, 
        error: 'API key was not saved correctly. Please check Docker volume mount.' 
      });
    }

    console.log('✓ TMDB API key verified in database');
    
    // Update TMDB client configuration
    console.log('Updating TMDB client configuration...');
    const tmdbClient = (await import('../tmdb/client')).default;
    tmdbClient.setApiKey(trimmedKey);
    console.log('✓ TMDB client configuration updated');

    res.json({ success: true, message: 'TMDB API key saved successfully' });
  } catch (error: any) {
    console.error('Save TMDB API key error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to save TMDB API key: ' + (error?.message || 'Unknown error') 
    });
  }
});

router.post('/omdb-api-key', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    
    console.log('=== Saving OMDB API Key ===');
    console.log('Received API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'Missing');
    console.log('Database path:', process.env.DB_PATH || './data/app.db');
    
    // Trim whitespace
    const trimmedKey = (apiKey || '').trim();
    
    console.log('Saving to database...');
    settingsModel.set('omdb_api_key', trimmedKey);
    
    console.log('Settings saved. Verifying...');
    
    // Immediately verify it was saved
    const allSettings = settingsModel.getAll();
    console.log('Total settings in database:', allSettings.length);
    
    const savedKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
    
    console.log('Saved Key:', savedKey ? `${savedKey.substring(0, 10)}...` : 'NOT FOUND');
    
    if (savedKey !== trimmedKey) {
      console.error('ERROR: Saved value does not match input value!');
      console.error('Expected:', trimmedKey);
      console.error('Got:', savedKey);
      return res.status(500).json({ 
        success: false, 
        error: 'API key was not saved correctly. Please check Docker volume mount.' 
      });
    }

    console.log('✓ OMDB API key verified in database');
    
    // Update IMDB client configuration
    console.log('Updating IMDB client configuration...');
    const imdbClient = (await import('../imdb/client')).default;
    imdbClient.setApiKey(trimmedKey);
    console.log('✓ IMDB client configuration updated');

    res.json({ success: true, message: 'OMDB API key saved successfully' });
  } catch (error: any) {
    console.error('Save OMDB API key error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to save OMDB API key: ' + (error?.message || 'Unknown error') 
    });
  }
});

router.post('/brave-api-key', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    
    console.log('=== Saving Brave API Key ===');
    console.log('Received API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'Missing');
    console.log('Database path:', process.env.DB_PATH || './data/app.db');
    
    // Trim whitespace
    const trimmedKey = (apiKey || '').trim();
    
    console.log('Saving to database...');
    settingsModel.set('brave_api_key', trimmedKey);
    
    console.log('Settings saved. Verifying...');
    
    // Immediately verify it was saved
    const allSettings = settingsModel.getAll();
    console.log('Total settings in database:', allSettings.length);
    
    const savedKey = allSettings.find(s => s.key === 'brave_api_key')?.value;
    
    console.log('Saved Key:', savedKey ? `${savedKey.substring(0, 10)}...` : 'NOT FOUND');
    
    if (savedKey !== trimmedKey) {
      console.error('ERROR: Saved value does not match input value!');
      console.error('Expected:', trimmedKey);
      console.error('Got:', savedKey);
      return res.status(500).json({ 
        success: false, 
        error: 'API key was not saved correctly. Please check Docker volume mount.' 
      });
    }

    console.log('✓ Brave API key verified in database');
    
    // Update Brave client configuration
    console.log('Updating Brave client configuration...');
    const braveClient = (await import('../brave/client')).default;
    braveClient.setApiKey(trimmedKey);
    console.log('✓ Brave client configuration updated');

    res.json({ success: true, message: 'Brave Search API key saved successfully' });
  } catch (error: any) {
    console.error('Save Brave API key error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to save Brave API key: ' + (error?.message || 'Unknown error') 
    });
  }
});

router.post('/radarr-config', async (req: Request, res: Response) => {
  console.log('=== POST /settings/radarr-config RECEIVED ===');
  console.log('Request body keys:', Object.keys(req.body));
  console.log('Request body:', JSON.stringify({ ...req.body, apiKey: req.body.apiKey ? '***HIDDEN***' : undefined }));
  
  try {
    const { apiUrl, apiKey } = req.body;
    
    console.log('=== Saving Radarr Config ===');
    console.log('Received URL:', apiUrl ? `${apiUrl.substring(0, 20)}...` : 'Missing');
    console.log('Received Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'Missing');
    
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

    console.log('Saving to database...');
    console.log('Database path:', process.env.DB_PATH || './data/app.db');
    
    // Save to database
    settingsModel.set('radarr_api_url', trimmedUrl);
    settingsModel.set('radarr_api_key', trimmedKey);
    
    console.log('Settings saved. Verifying...');
    
    // Immediately verify it was saved
    const allSettings = settingsModel.getAll();
    console.log('Total settings in database:', allSettings.length);
    console.log('All settings keys:', allSettings.map(s => s.key).join(', '));
    
    const savedUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value;
    const savedKey = allSettings.find(s => s.key === 'radarr_api_key')?.value;
    
    console.log('Saved URL:', savedUrl ? `${savedUrl.substring(0, 20)}...` : 'NOT FOUND');
    console.log('Saved Key:', savedKey ? `${savedKey.substring(0, 10)}...` : 'NOT FOUND');
    
    if (!savedUrl || !savedKey) {
      console.error('ERROR: Settings were not found in database after saving!');
      return res.status(500).json({ 
        success: false, 
        error: 'Configuration was not saved correctly. Database may not be persisting. Check Docker volume mount.' 
      });
    }
    
    if (savedUrl !== trimmedUrl || savedKey !== trimmedKey) {
      console.error('ERROR: Saved values do not match input values!');
      console.error('Expected URL:', trimmedUrl);
      console.error('Got URL:', savedUrl);
      return res.status(500).json({ success: false, error: 'Configuration values do not match. Please try again.' });
    }

    console.log('✓ Settings verified in database');

    // Update Radarr client configuration
    console.log('Updating Radarr client configuration...');
    const radarrClient = (await import('../radarr/client')).default;
    radarrClient.updateConfig();
    
    // Verify client can read the settings
    const clientSettings = settingsModel.getAll();
    const clientUrl = clientSettings.find(s => s.key === 'radarr_api_url')?.value;
    const clientKey = clientSettings.find(s => s.key === 'radarr_api_key')?.value;
    console.log('Client can read URL:', clientUrl ? 'Yes' : 'No');
    console.log('Client can read Key:', clientKey ? 'Yes' : 'No');
    
    console.log('=== Radarr Config Save Complete ===');
    res.json({ success: true, message: 'Radarr configuration saved successfully' });
  } catch (error: any) {
    console.error('Save Radarr config error:', error);
    console.error('Error stack:', error?.stack);
    res.status(500).json({ success: false, error: 'Failed to save Radarr configuration: ' + (error?.message || 'Unknown error') });
  }
});

router.post('/sonarr-config', async (req: Request, res: Response) => {
  console.log('=== POST /settings/sonarr-config RECEIVED ===');
  try {
    const { apiUrl, apiKey } = req.body;

    if (!apiUrl || !apiKey) {
      return res.status(400).json({ success: false, error: 'Sonarr API URL and Key are required' });
    }

    const trimmedUrl = apiUrl.trim();
    const trimmedKey = apiKey.trim();

    try {
      new URL(trimmedUrl);
    } catch (error) {
      console.error('Sonarr config validation failed: Invalid URL format', trimmedUrl);
      return res.status(400).json({ success: false, error: 'Invalid Sonarr API URL format' });
    }

    settingsModel.set('sonarr_api_url', trimmedUrl);
    settingsModel.set('sonarr_api_key', trimmedKey);

    const allSettings = settingsModel.getAll();
    const savedUrl = allSettings.find(s => s.key === 'sonarr_api_url')?.value;
    const savedKey = allSettings.find(s => s.key === 'sonarr_api_key')?.value;

    if (!savedUrl || !savedKey || savedUrl !== trimmedUrl || savedKey !== trimmedKey) {
      return res.status(500).json({ success: false, error: 'Sonarr configuration was not saved correctly. Please try again.' });
    }

    const sonarrClient = (await import('../sonarr/client')).default;
    sonarrClient.updateConfig();

    res.json({ success: true, message: 'Sonarr configuration saved successfully' });
  } catch (error: any) {
    console.error('Save Sonarr config error:', error);
    return res.status(500).json({ success: false, error: 'Failed to save Sonarr configuration: ' + (error?.message || 'Unknown error') });
  }
});

router.post('/tvdb-config', async (req: Request, res: Response) => {
  try {
    const { apiKey, userPin } = req.body;

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'TVDB API key is required' });
    }

    const trimmedKey = apiKey.trim();
    const trimmedPin = (userPin || '').trim();

    settingsModel.set('tvdb_api_key', trimmedKey);
    settingsModel.set('tvdb_user_pin', trimmedPin);

    const allSettings = settingsModel.getAll();
    const savedKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    const savedPin = allSettings.find(s => s.key === 'tvdb_user_pin')?.value ?? '';

    if (savedKey !== trimmedKey || savedPin !== trimmedPin) {
      return res.status(500).json({ success: false, error: 'TVDB credentials were not saved correctly. Please try again.' });
    }

    const tvdbClient = (await import('../tvdb/client')).default;
    tvdbClient.updateConfig();

    res.json({ success: true, message: 'TVDB credentials saved successfully' });
  } catch (error: any) {
    console.error('Save TVDB config error:', error);
    res.status(500).json({ success: false, error: 'Failed to save TVDB configuration: ' + (error?.message || 'Unknown error') });
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

// Debug endpoint to check database values
router.get('/debug/radarr-config', (req: Request, res: Response) => {
  try {
    const allSettings = settingsModel.getAll();
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url');
    const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key');
    
    res.json({
      success: true,
      database: {
        radarr_api_url: radarrApiUrl ? {
          exists: true,
          value: radarrApiUrl.value ? `${radarrApiUrl.value.substring(0, 30)}...` : 'empty',
          length: radarrApiUrl.value?.length || 0
        } : { exists: false },
        radarr_api_key: radarrApiKey ? {
          exists: true,
          value: radarrApiKey.value ? `${radarrApiKey.value.substring(0, 10)}...` : 'empty',
          length: radarrApiKey.value?.length || 0
        } : { exists: false }
      },
      allSettingsKeys: allSettings.map(s => s.key),
      totalSettings: allSettings.length
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug endpoint to check all API keys
router.get('/debug/api-keys', (req: Request, res: Response) => {
  try {
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key');
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key');
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key');
    
    res.json({
      success: true,
      database: {
        tmdb_api_key: tmdbApiKey ? {
          exists: true,
          value: tmdbApiKey.value ? `${tmdbApiKey.value.substring(0, 10)}...` : 'empty',
          length: tmdbApiKey.value?.length || 0
        } : { exists: false },
        omdb_api_key: omdbApiKey ? {
          exists: true,
          value: omdbApiKey.value ? `${omdbApiKey.value.substring(0, 10)}...` : 'empty',
          length: omdbApiKey.value?.length || 0
        } : { exists: false },
        brave_api_key: braveApiKey ? {
          exists: true,
          value: braveApiKey.value ? `${braveApiKey.value.substring(0, 10)}...` : 'empty',
          length: braveApiKey.value?.length || 0
        } : { exists: false }
      },
      allSettingsKeys: allSettings.map(s => s.key),
      totalSettings: allSettings.length
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

