import { Router, Request, Response } from 'express';
import { getSyncedRadarrMovies, getLastRadarrSync, syncRadarrMovies } from '../services/radarrSync';
import { getSyncedRssItems, getSyncedRssItemsByFeed, getLastRssSync } from '../services/rssSync';
import { feedsModel } from '../models/feeds';
import { syncProgress } from '../services/syncProgress';

const router = Router();

// Radarr Data page
router.get('/radarr', (req: Request, res: Response) => {
  try {
    const movies = getSyncedRadarrMovies();
    const lastSync = getLastRadarrSync();
    
    res.render('radarr-data', {
      movies,
      lastSync,
      totalMovies: movies.length,
      moviesWithFiles: movies.filter((m: any) => m.has_file).length,
    });
  } catch (error) {
    console.error('Radarr data page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Trigger Radarr sync
router.post('/radarr/sync', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'radarr') {
      return res.json({ success: false, message: 'Radarr sync is already in progress' });
    }

    // Start sync in background
    (async () => {
      try {
        await syncRadarrMovies();
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Radarr sync error:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
      }
    })();

    res.json({ success: true, message: 'Radarr sync started' });
  } catch (error) {
    console.error('Start Radarr sync error:', error);
    res.status(500).json({ error: 'Failed to start Radarr sync' });
  }
});

// Get sync progress
router.get('/radarr/sync/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({ success: true, progress });
  } catch (error) {
    console.error('Get sync progress error:', error);
    res.status(500).json({ error: 'Failed to get sync progress' });
  }
});

// RSS Feed Data page
router.get('/rss', (req: Request, res: Response) => {
  try {
    const feedId = req.query.feedId ? parseInt(req.query.feedId as string, 10) : undefined;
    const feeds = feedsModel.getAll();
    const itemsByFeed = getSyncedRssItemsByFeed();
    const items = getSyncedRssItems(feedId);
    const lastSync = getLastRssSync();
    
    res.render('rss-data', {
      feeds,
      itemsByFeed,
      items,
      selectedFeedId: feedId,
      lastSync,
      totalItems: items.length,
    });
  } catch (error) {
    console.error('RSS data page error:', error);
    res.status(500).send('Internal server error');
  }
});

export default router;

