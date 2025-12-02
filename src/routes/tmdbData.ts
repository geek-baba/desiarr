import { Router, Request, Response } from 'express';
import { initialTmdbSync, incrementalTmdbSync, getTmdbSyncStatus } from '../services/tmdbSync';
import { syncProgress } from '../services/syncProgress';

const router = Router();

/**
 * TMDB Data page
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = getTmdbSyncStatus();
    const progress = syncProgress.get();

    res.render('tmdb-data', {
      currentPage: 'tmdb-data',
      lastSyncDate: status.lastSyncDate,
      totalCached: status.totalCached,
      pendingUpdates: status.pendingUpdates,
      isSyncing: progress?.isRunning && progress?.type === 'tmdb-sync',
      progress: progress || null,
    });
  } catch (error) {
    console.error('TMDB Data page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Start initial TMDB sync
 */
router.post('/sync/initial', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const progress = syncProgress.get();
    if (progress?.isRunning && progress?.type === 'tmdb-sync') {
      return res.status(400).json({
        success: false,
        error: 'TMDB sync is already in progress',
      });
    }

    // Start sync in background (don't await)
    initialTmdbSync().catch(error => {
      console.error('Background TMDB sync error:', error);
    });

    res.json({
      success: true,
      message: 'Initial TMDB sync started',
    });
  } catch (error: any) {
    console.error('Start initial sync error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to start sync',
    });
  }
});

/**
 * Start incremental TMDB sync
 */
router.post('/sync/incremental', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const progress = syncProgress.get();
    if (progress?.isRunning && progress?.type === 'tmdb-sync') {
      return res.status(400).json({
        success: false,
        error: 'TMDB sync is already in progress',
      });
    }

    // Start sync in background (don't await)
    incrementalTmdbSync().catch(error => {
      console.error('Background TMDB sync error:', error);
    });

    res.json({
      success: true,
      message: 'Incremental TMDB sync started',
    });
  } catch (error: any) {
    console.error('Start incremental sync error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to start sync',
    });
  }
});

/**
 * Get sync progress (for polling)
 */
router.get('/sync/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({
      success: true,
      progress: progress || null,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to get progress',
    });
  }
});

export default router;

