import { Router, Request, Response } from 'express';
import { getSyncedRadarrMovies, getLastRadarrSync, syncRadarrMovies, getSyncedRadarrMovieByTmdbId, getSyncedRadarrMovieByRadarrId } from '../services/radarrSync';
import { getSyncedSonarrShows, getLastSonarrSync, syncSonarrShows, getSyncedSonarrShowBySonarrId } from '../services/sonarrSync';
import { getSyncedRssItems, getSyncedRssItemsByFeed, getLastRssSync, syncRssFeeds, backfillMissingIds } from '../services/rssSync';
import { feedsModel } from '../models/feeds';
import { releasesModel } from '../models/releases';
import { tvReleasesModel } from '../models/tvReleases';
import { syncProgress } from '../services/syncProgress';
import { logStorage } from '../services/logStorage';
import db from '../db';
import { parseRSSItem } from '../rss/parseRelease';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import braveClient from '../brave/client';
import tvdbClient from '../tvdb/client';
import { settingsModel } from '../models/settings';
import { runMatchingEngine } from '../services/matchingEngine';
import { runTvMatchingEngine } from '../services/tvMatchingEngine';
import { backfillTvdbSlugs } from '../services/tvdbSlugBackfill';

const router = Router();

/**
 * Generate TVDB URL from TVDB ID, slug, and show name
 * TVDB v4 uses slug-based URLs: https://thetvdb.com/series/{slug}
 * Prefers API-provided slug, falls back to generated slug, then numeric ID
 */
function getTvdbUrl(tvdbId: number | undefined | null, tvdbSlug?: string | null, showName?: string): string | null {
  if (!tvdbId) {
    return null;
  }
  
  // Use API-provided slug if available (most reliable)
  if (tvdbSlug) {
    return `https://thetvdb.com/series/${tvdbSlug}`;
  }
  
  // Try to create slug from show name if available
  if (showName) {
    const slug = showName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    
    if (slug) {
      return `https://thetvdb.com/series/${slug}`;
    }
  }
  
  // Fallback to numeric ID format (may not work for all series)
  return `https://thetvdb.com/series/${tvdbId}`;
}

// Releases page - flattened list of all releases with TMDB metadata
router.get('/releases', (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string) || '';
    const allReleases = releasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Get feed names and types for display and filtering
    const feedMap: { [key: number]: string } = {};
    const feedTypeMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
        feedTypeMap[feed.id] = feed.feed_type || 'movie';
      }
    }
    
    // Filter out releases from TV feeds - only show movie releases
    const movieReleases = allReleases.filter(release => {
      const feedType = feedTypeMap[release.feed_id] || 'movie';
      return feedType === 'movie';
    });
    
    // Filter releases by search term if provided
    let filteredReleases = movieReleases;
    if (search && search.trim()) {
      const searchLower = search.toLowerCase().trim();
      filteredReleases = movieReleases.filter(release => {
        const title = (release.title || '').toLowerCase();
        const normalizedTitle = (release.normalized_title || '').toLowerCase();
        const tmdbTitle = (release.tmdb_title || '').toLowerCase();
        const radarrTitle = (release.radarr_movie_title || '').toLowerCase();
        const status = (release.status || '').toLowerCase();
        const resolution = (release.resolution || '').toLowerCase();
        const sourceTag = (release.source_tag || '').toLowerCase();
        const codec = (release.codec || '').toLowerCase();
        
        return title.includes(searchLower) ||
               normalizedTitle.includes(searchLower) ||
               tmdbTitle.includes(searchLower) ||
               radarrTitle.includes(searchLower) ||
               status.includes(searchLower) ||
               resolution.includes(searchLower) ||
               sourceTag.includes(searchLower) ||
               codec.includes(searchLower);
      });
    }
    
    // Enrich releases with metadata (posters, etc.)
    const enrichedReleases = filteredReleases.map(release => {
      const enriched: any = {
        ...release,
        feedName: feedMap[release.feed_id] || 'Unknown Feed',
        posterUrl: undefined,
      };
      
      // Get poster URL from release's tmdb_poster_url first
      if (release.tmdb_poster_url) {
        enriched.posterUrl = release.tmdb_poster_url;
      } else if (release.tmdb_id || release.radarr_movie_id) {
        // Fall back to synced Radarr data
        let syncedMovie: any = null;
        if (release.radarr_movie_id) {
          syncedMovie = getSyncedRadarrMovieByRadarrId(release.radarr_movie_id);
        } else if (release.tmdb_id) {
          syncedMovie = getSyncedRadarrMovieByTmdbId(release.tmdb_id);
        }
        
        if (syncedMovie && syncedMovie.images) {
          try {
            const images = JSON.parse(syncedMovie.images);
            if (Array.isArray(images) && images.length > 0) {
              const poster = images.find((img: any) => img.coverType === 'poster');
              if (poster) {
                enriched.posterUrl = poster.remoteUrl || poster.url;
              }
            }
          } catch (error) {
            // Ignore parsing errors
          }
        }
      }
      
      return enriched;
    });
    
    // Sort by published_at (newest first)
    enrichedReleases.sort((a, b) => {
      const dateA = new Date(a.published_at).getTime();
      const dateB = new Date(b.published_at).getTime();
      return dateB - dateA;
    });
    
    // Get last refresh time (matching engine last run, same as dashboard)
    const lastRefreshResult = db.prepare("SELECT value FROM app_settings WHERE key = 'matching_last_run'").get() as { value: string } | undefined;
    const lastRefresh = lastRefreshResult?.value ? new Date(lastRefreshResult.value) : null;
    
    res.render('releases-list', {
      releases: enrichedReleases,
      totalReleases: movieReleases.length,
      filteredCount: enrichedReleases.length,
      search,
      hideRefresh: true,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
    });
  } catch (error) {
    console.error('All Releases page error:', error);
    res.status(500).send('Internal server error');
  }
});

// TV Releases page - flattened list of all TV releases
router.get('/tv-releases', (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string) || '';
    const allTvReleases = tvReleasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Get feed names for display
    const feedMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
      }
    }
    
    // Filter releases by search term if provided
    let filteredReleases = allTvReleases;
    if (search && search.trim()) {
      const searchLower = search.toLowerCase().trim();
      filteredReleases = allTvReleases.filter(release => {
        const title = (release.title || '').toLowerCase();
        const showName = (release.show_name || '').toLowerCase();
        const sonarrTitle = (release.sonarr_series_title || '').toLowerCase();
        const status = (release.status || '').toLowerCase();
        
        return title.includes(searchLower) ||
               showName.includes(searchLower) ||
               sonarrTitle.includes(searchLower) ||
               status.includes(searchLower);
      });
    }
    
    // Enrich with feed names, poster URLs, and RSS metadata
    const enrichedReleases = filteredReleases.map(release => {
      const enriched: any = {
        ...release,
        feed_name: feedMap[release.feed_id] || 'Unknown Feed',
        posterUrl: undefined,
      };
      
      // Get poster URL from release's tmdb_poster_url or tvdb_poster_url first
      if (release.tmdb_poster_url) {
        enriched.posterUrl = release.tmdb_poster_url;
      } else if (release.tvdb_poster_url) {
        enriched.posterUrl = release.tvdb_poster_url;
      } else if (release.tmdb_id || release.sonarr_series_id) {
        // Fall back to synced Sonarr data
        let syncedShow: any = null;
        if (release.sonarr_series_id) {
          syncedShow = getSyncedSonarrShowBySonarrId(release.sonarr_series_id);
        } else if (release.tmdb_id) {
          // Get by TMDB ID - need to search sonarr_shows
          const show = db.prepare('SELECT * FROM sonarr_shows WHERE tmdb_id = ?').get(release.tmdb_id) as any;
          if (show) {
            try {
              syncedShow = {
                ...show,
                monitored: Boolean(show.monitored),
                seasons: show.seasons ? JSON.parse(show.seasons) : null,
                images: show.images ? JSON.parse(show.images) : null,
              };
            } catch (error) {
              // Ignore parsing errors
            }
          }
        }
        
        if (syncedShow && syncedShow.images) {
          try {
            const images = syncedShow.images; // Already parsed by getSyncedSonarrShowBySonarrId
            if (Array.isArray(images) && images.length > 0) {
              const poster = images.find((img: any) => img.coverType === 'poster');
              if (poster) {
                enriched.posterUrl = poster.remoteUrl || poster.url;
              }
            }
          } catch (error) {
            // Ignore parsing errors
          }
        }
      }
      
      // Get RSS item metadata (quality, size, etc.) by matching guid
      const rssItem = db.prepare('SELECT * FROM rss_feed_items WHERE guid = ?').get(release.guid) as any;
      if (rssItem) {
        enriched.resolution = rssItem.resolution;
        enriched.codec = rssItem.codec;
        enriched.source_tag = rssItem.source_tag;
        enriched.audio = rssItem.audio;
        enriched.rss_size_mb = rssItem.rss_size_mb;
      }
      
      return enriched;
    });
    
    // Get last refresh time (matching engine last run)
    const lastRefreshResult = db.prepare("SELECT value FROM app_settings WHERE key = 'matching_last_run'").get() as { value: string } | undefined;
    const lastRefresh = lastRefreshResult?.value ? new Date(lastRefreshResult.value) : null;
    
    res.render('tv-releases-list', {
      releases: enrichedReleases,
      totalReleases: allTvReleases.length,
      filteredCount: enrichedReleases.length,
      search,
      hideRefresh: true,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
    });
  } catch (error) {
    console.error('TV Releases page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Radarr Data page
router.get('/radarr', (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const search = req.query.search as string || '';
    const { movies, total } = getSyncedRadarrMovies(page, 50, search);
    const lastSync = getLastRadarrSync();
    
    // Get total counts for stats (without pagination)
    const allMovies = getSyncedRadarrMovies(1, 999999); // Get all for stats
    const totalMovies = allMovies.total;
    const moviesWithFiles = allMovies.movies.filter((m: any) => m.has_file).length;
    
    const totalPages = Math.ceil(total / 50);
    
    res.render('radarr-data', {
      movies,
      lastSync,
      totalMovies,
      moviesWithFiles,
      currentPage: page,
      totalPages,
      total,
      search,
      hideRefresh: true,
      lastRefresh: lastSync ? (typeof lastSync === 'string' ? lastSync : lastSync.toISOString()) : null,
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
        console.log('Starting Radarr sync from API endpoint...');
        await syncRadarrMovies();
        console.log('Radarr sync completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Radarr sync error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error('Error message:', errorMessage);
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Radarr sync started' });
  } catch (error: any) {
    console.error('Start Radarr sync error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start Radarr sync',
      message: error?.message || 'Unknown error'
    });
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

// Sonarr Data page
router.get('/sonarr', (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const search = req.query.search as string || '';
    const { shows, total } = getSyncedSonarrShows(page, 50, search);
    const lastSync = getLastSonarrSync();
    
    // Get total counts for stats (without pagination)
    const allShows = getSyncedSonarrShows(1, 999999); // Get all for stats
    const totalShows = allShows.total;
    const monitoredShows = allShows.shows.filter((s: any) => s.monitored).length;
    
    const totalPages = Math.ceil(total / 50);
    
    // Enrich shows with TVDB URLs
    // Note: We don't have slug stored, so we'll generate from title
    const showsWithUrls = shows.map((show: any) => ({
      ...show,
      tvdb_url: getTvdbUrl(show.tvdb_id, null, show.title),
    }));
    
    res.render('sonarr-data', {
      shows: showsWithUrls,
      lastSync,
      totalShows,
      monitoredShows,
      currentPage: page,
      totalPages,
      total,
      search,
      hideRefresh: true,
      lastRefresh: lastSync ? (typeof lastSync === 'string' ? lastSync : lastSync.toISOString()) : null,
    });
  } catch (error) {
    console.error('Sonarr data page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Trigger Sonarr sync
router.post('/sonarr/sync', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'sonarr') {
      return res.json({ success: false, message: 'Sonarr sync is already in progress' });
    }

    // Start sync in background
    (async () => {
      try {
        console.log('Starting Sonarr sync from API endpoint...');
        await syncSonarrShows();
        console.log('Sonarr sync completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Sonarr sync error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error('Error message:', errorMessage);
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Sonarr sync started' });
  } catch (error: any) {
    console.error('Start Sonarr sync error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start Sonarr sync',
      message: error?.message || 'Unknown error'
    });
  }
});

// Get Sonarr sync progress
router.get('/sonarr/sync/progress', (req: Request, res: Response) => {
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
    const feedType = req.query.feedType as string | undefined; // 'movie' or 'tv'
    const feeds = feedsModel.getAll();
    const itemsByFeed = getSyncedRssItemsByFeed();
    
    // Get items with feed type and TVDB ID (from rss_feed_items first, then tv_releases as fallback)
    let items: any[];
    if (feedId) {
      items = db.prepare(`
        SELECT 
          rss.*,
          f.feed_type,
          COALESCE(rss.tvdb_id, tv.tvdb_id) as tvdb_id,
          tv.tvdb_slug
        FROM rss_feed_items rss
        LEFT JOIN rss_feeds f ON rss.feed_id = f.id
        LEFT JOIN tv_releases tv ON rss.guid = tv.guid
        WHERE rss.feed_id = ?
        ORDER BY datetime(rss.published_at) DESC, rss.id DESC
      `).all(feedId);
    } else if (feedType) {
      items = db.prepare(`
        SELECT 
          rss.*,
          f.feed_type,
          COALESCE(rss.tvdb_id, tv.tvdb_id) as tvdb_id,
          tv.tvdb_slug
        FROM rss_feed_items rss
        LEFT JOIN rss_feeds f ON rss.feed_id = f.id
        LEFT JOIN tv_releases tv ON rss.guid = tv.guid
        WHERE f.feed_type = ?
        ORDER BY datetime(rss.published_at) DESC, rss.id DESC
      `).all(feedType);
    } else {
      // Sort by published_at DESC globally (latest first), with id as tiebreaker for consistent ordering
      items = db.prepare(`
        SELECT 
          rss.*,
          f.feed_type,
          COALESCE(rss.tvdb_id, tv.tvdb_id) as tvdb_id,
          tv.tvdb_slug
        FROM rss_feed_items rss
        LEFT JOIN rss_feeds f ON rss.feed_id = f.id
        LEFT JOIN tv_releases tv ON rss.guid = tv.guid
        ORDER BY datetime(rss.published_at) DESC, rss.id DESC
      `).all();
    }
    
    const lastSync = getLastRssSync();
    
    // Convert lastSync to ISO string for header display
    const lastRefresh = lastSync ? (typeof lastSync === 'string' ? lastSync : lastSync.toISOString()) : null;
    
    // Enrich items with TVDB URLs (for TV shows)
    // Use stored slug from database if available
    const itemsWithUrls = items.map((item: any) => {
      if (item.feed_type === 'tv' && item.tvdb_id) {
        // Try to get show name from title or normalized_title
        const showName = item.title || item.normalized_title || '';
        return {
          ...item,
          tvdb_url: getTvdbUrl(item.tvdb_id, item.tvdb_slug, showName),
        };
      }
      return item;
    });
    
    res.render('rss-data', {
      feeds,
      itemsByFeed,
      items: itemsWithUrls,
      selectedFeedId: feedId,
      selectedFeedType: feedType,
      lastSync,
      totalItems: items.length,
      lastRefresh,
    });
  } catch (error) {
    console.error('RSS data page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Trigger RSS sync
router.post('/rss/sync', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running - only check if actually running, not just if progress exists
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'rss') {
      return res.json({ success: false, message: 'RSS sync is already in progress' });
    }
    
    // Clear any stale progress that's not actually running
    if (current && !current.isRunning && current.type === 'rss') {
      syncProgress.clear();
    }

    // Start sync in background
    (async () => {
      try {
        console.log('Starting RSS sync from API endpoint...');
        await syncRssFeeds();
        console.log('RSS sync completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('RSS sync error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error('Error message:', errorMessage);
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'RSS sync started' });
  } catch (error: any) {
    console.error('Start RSS sync error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start RSS sync',
      message: error?.message || 'Unknown error'
    });
  }
});

// Get RSS sync progress
router.get('/rss/sync/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({ success: true, progress });
  } catch (error) {
    console.error('Get RSS sync progress error:', error);
    res.status(500).json({ error: 'Failed to get RSS sync progress' });
  }
});

// Log Explorer page (new)
router.get('/logs', (req: Request, res: Response) => {
  try {
    res.render('log-explorer', {
      hideRefresh: true
    });
  } catch (error) {
    console.error('Log Explorer page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Old logs page (kept for backward compatibility, redirects to new explorer)
router.get('/logs-old', (req: Request, res: Response) => {
  try {
    const filter = req.query.filter as string || '';
    const limit = parseInt(req.query.limit as string || '500', 10);
    
    const logs = filter 
      ? logStorage.getLogsByFilter(filter, limit)
      : logStorage.getLogs(limit);
    
    res.render('logs', {
      logs,
      filter,
      totalLogs: logStorage.getCount(),
    });
  } catch (error) {
    console.error('Logs page error:', error);
    res.status(500).send('Internal server error');
  }
});

// Get logs API (for auto-refresh)
router.get('/logs/api', (req: Request, res: Response) => {
  try {
    const filter = req.query.filter as string || '';
    const limit = parseInt(req.query.limit as string || '500', 10);
    
    const logs = filter 
      ? logStorage.getLogsByFilter(filter, limit)
      : logStorage.getLogs(limit);
    
    res.json({ success: true, logs, totalLogs: logStorage.getCount() });
  } catch (error) {
    console.error('Get logs API error:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// Clear logs
router.post('/logs/clear', (req: Request, res: Response) => {
  try {
    logStorage.clear();
    res.json({ success: true });
  } catch (error) {
    console.error('Clear logs error:', error);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

// Backfill missing IDs for all RSS items
router.post('/rss/backfill-ids', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'rss') {
      return res.json({ success: false, message: 'RSS sync is already in progress' });
    }

    // Start backfill in background
    (async () => {
      try {
        console.log('Starting backfill of missing IDs from API endpoint...');
        syncProgress.start('rss', 0);
        syncProgress.update('Starting backfill...', 0);
        
        const stats = await backfillMissingIds();
        
        syncProgress.update('Backfill completed', stats.processed, stats.processed, stats.errors);
        syncProgress.complete();
        
        console.log('Backfill completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Backfill error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Backfill started' });
  } catch (error: any) {
    console.error('Start backfill error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start backfill',
      message: error?.message || 'Unknown error'
    });
  }
});

// Override TMDB ID for RSS item
router.post('/rss/override-tmdb/:id', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    const { tmdbId, action } = req.body as { tmdbId?: string; action?: string };

    // Get the RSS item from database (needed for both override + clear)
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    // Handle clear action
    if (action === 'clear') {
      db.prepare(`
        UPDATE rss_feed_items 
        SET tmdb_id = NULL, tmdb_id_manual = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(itemId);

      console.log(`Cleared TMDB ID for RSS item ${itemId}`);

      return res.json({
        success: true,
        message: 'TMDB ID cleared. This item will remain unmatched until you set a new ID manually.',
      });
    }

    if (!tmdbId || isNaN(parseInt(tmdbId, 10))) {
      return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
    }

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    
    if (!tmdbApiKey) {
      return res.status(400).json({ success: false, error: 'TMDB API key not configured' });
    }

    tmdbClient.setApiKey(tmdbApiKey);

    // Verify the TMDB ID by fetching movie details
    const tmdbMovie = await tmdbClient.getMovie(parseInt(tmdbId, 10));
    if (!tmdbMovie) {
      return res.status(404).json({ success: false, error: 'TMDB ID not found' });
    }

    // Extract IMDB ID from TMDB movie
    let imdbId = item.imdb_id;
    if (tmdbMovie.imdb_id) {
      imdbId = tmdbMovie.imdb_id;
    }

    // Update the RSS item with the new TMDB ID and IMDB ID, mark as manually set
    db.prepare(`
      UPDATE rss_feed_items 
      SET tmdb_id = ?, imdb_id = ?, tmdb_id_manual = 1, imdb_id_manual = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(parseInt(tmdbId, 10), imdbId, imdbId ? 1 : 0, itemId);

    console.log(`Manually updated RSS item ${itemId} with TMDB ID ${tmdbId} and IMDB ID ${imdbId || 'none'}`);

    res.json({ 
      success: true, 
      message: `TMDB ID updated to ${tmdbId} (${tmdbMovie.title})`,
      tmdbId: parseInt(tmdbId, 10),
      imdbId: imdbId,
      tmdbTitle: tmdbMovie.title,
    });
  } catch (error: any) {
    console.error('Override TMDB ID for RSS item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to override TMDB ID: ' + (error?.message || 'Unknown error')
    });
  }
});

// Override TVDB ID for RSS item (TV feeds only)
router.post('/rss/override-tvdb/:id', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    const { tvdbId, action } = req.body as { tvdbId?: string; action?: string };
    
    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    // Check if this is a TV feed
    const feed = db.prepare('SELECT feed_type FROM rss_feeds WHERE id = ?').get(item.feed_id) as any;
    if (!feed || feed.feed_type !== 'tv') {
      return res.status(400).json({ success: false, error: 'TVDB override is only available for TV feeds' });
    }

    if (action === 'clear') {
      db.prepare(`
        UPDATE rss_feed_items
        SET tvdb_id = NULL, tvdb_id_manual = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(itemId);

      db.prepare(`
        UPDATE tv_releases
        SET tvdb_id = NULL, tvdb_slug = NULL, last_checked_at = datetime('now')
        WHERE guid = ?
      `).run(item.guid);

      console.log(`Cleared TVDB ID for RSS item ${itemId}`);

      return res.json({
        success: true,
        message: 'TVDB ID cleared. This show will remain unmatched until a new ID is set manually.',
      });
    }
    
    if (!tvdbId || isNaN(parseInt(tvdbId, 10))) {
      return res.status(400).json({ success: false, error: 'Valid TVDB ID is required' });
    }

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    const tvdbUserPin = allSettings.find(s => s.key === 'tvdb_user_pin')?.value;
    
    // TVDB v4 API: PIN is optional (only required for subscriber-supported API keys)
    if (!tvdbApiKey) {
      return res.status(400).json({ success: false, error: 'TVDB API key not configured' });
    }

    // Initialize TVDB client - update config and trigger authentication via a request
    tvdbClient.updateConfig();

    // Verify the TVDB ID by fetching series details
    const tvdbSeries = await tvdbClient.getSeries(parseInt(tvdbId, 10));
    if (!tvdbSeries) {
      return res.status(404).json({ success: false, error: 'TVDB ID not found' });
    }

    // Try to get TMDB and IMDB IDs from TVDB extended info, and also fetch the slug and poster
    let tmdbId = item.tmdb_id;
    let imdbId = item.imdb_id;
    let tvdbSlug: string | null = null;
    let tvdbPosterUrl: string | null = null;
    
    try {
      const tvdbExtended = await tvdbClient.getSeriesExtended(parseInt(tvdbId, 10));
      if (tvdbExtended) {
        // Extract slug from extended info
        tvdbSlug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
        
        // Extract poster URL (TVDB v4 structure may vary)
        const artwork = (tvdbExtended as any).artwork || (tvdbExtended as any).artworks;
        if (artwork && Array.isArray(artwork)) {
          const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster'); // Type 2 is poster
          if (poster) {
            tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
          }
        }
        
        // TVDB v4 structure - check for remoteIds
        const remoteIds = (tvdbExtended as any).remoteIds || [];
        const tmdbRemote = remoteIds.find((r: any) => r.source === 'tmdb' || r.source === 'themoviedb');
        const imdbRemote = remoteIds.find((r: any) => r.source === 'imdb');
        
        if (tmdbRemote && tmdbRemote.id) {
          tmdbId = parseInt(tmdbRemote.id, 10);
        }
        if (imdbRemote && imdbRemote.id) {
          imdbId = imdbRemote.id;
        }
      }
    } catch (error) {
      console.log('Could not fetch extended TVDB info, continuing with TVDB ID only');
    }
    
    // Fetch TMDB poster if we have a TMDB ID
    let tmdbPosterUrl: string | null = null;
    if (tmdbId) {
      try {
        const allSettings = settingsModel.getAll();
        const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
        if (tmdbApiKey) {
          tmdbClient.setApiKey(tmdbApiKey);
          const tmdbShow = await tmdbClient.getTvShow(tmdbId);
          if (tmdbShow && tmdbShow.poster_path) {
            tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}`;
          }
        }
      } catch (error) {
        console.log('Could not fetch TMDB poster, continuing without it');
      }
    }

    // Update the RSS item with the new TVDB ID and any found IDs, mark as manually set
    db.prepare(`
      UPDATE rss_feed_items 
      SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, tvdb_id_manual = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(parseInt(tvdbId, 10), tmdbId || null, imdbId || null, itemId);

    // Propagate IDs to all other RSS items for the same TV show
    // Strategy: Update all RSS items that have the same TVDB ID (after we set it)
    // This handles the common case where one show has multiple episodes/seasons
    const allRssItemsWithSameTvdb = db.prepare(`
      SELECT id FROM rss_feed_items 
      WHERE tvdb_id = ? AND id != ? AND feed_id IN (SELECT id FROM rss_feeds WHERE feed_type = 'tv')
    `).all(parseInt(tvdbId, 10), itemId) as any[];
    
    let propagatedCount = 0;
    for (const otherItem of allRssItemsWithSameTvdb) {
      // Only update if the item doesn't already have manual overrides
      const otherItemFull = db.prepare('SELECT tvdb_id_manual FROM rss_feed_items WHERE id = ?').get(otherItem.id) as any;
      if (!otherItemFull?.tvdb_id_manual) {
        db.prepare(`
          UPDATE rss_feed_items 
          SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(parseInt(tvdbId, 10), tmdbId || null, imdbId || null, otherItem.id);
        propagatedCount++;
      }
    }
    
    // Also propagate to items that will match to the same TVDB ID (by show name)
    // This helps when items don't have TVDB ID yet but will match to the same show
    const { parseTvTitle } = await import('../services/tvMatchingEngine');
    const parsedTitle = parseTvTitle(item.title);
    const showNameForMatching = parsedTitle.showName.toLowerCase().trim();
    
    if (showNameForMatching && showNameForMatching.length > 2) {
      // Find all RSS items from TV feeds that parse to the same show name
      const allTvRssItems = db.prepare(`
        SELECT rss.*, f.feed_type
        FROM rss_feed_items rss
        LEFT JOIN rss_feeds f ON rss.feed_id = f.id
        WHERE f.feed_type = 'tv' AND rss.id != ? AND (rss.tvdb_id IS NULL OR rss.tvdb_id != ?)
      `).all(itemId, parseInt(tvdbId, 10)) as any[];
      
      for (const otherItem of allTvRssItems) {
        const otherParsed = parseTvTitle(otherItem.title);
        const otherShowName = otherParsed.showName.toLowerCase().trim();
        
        // If show names match (exact or fuzzy), propagate IDs
        if (otherShowName === showNameForMatching || 
            (showNameForMatching.length > 3 && otherShowName.includes(showNameForMatching)) ||
            (otherShowName.length > 3 && showNameForMatching.includes(otherShowName))) {
          // Only update if the item doesn't already have manual overrides
          const hasManualTvdb = otherItem.tvdb_id_manual;
          if (!hasManualTvdb) {
            db.prepare(`
              UPDATE rss_feed_items 
              SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(parseInt(tvdbId, 10), tmdbId || null, imdbId || null, otherItem.id);
            propagatedCount++;
          }
        }
      }
    }
    
    if (propagatedCount > 0) {
      console.log(`  ✓ Propagated IDs to ${propagatedCount} additional RSS item(s) for the same show`);
    }

    // Update tv_releases - update the specific release by guid, and also update all releases with the same TVDB ID
    const tvRelease = db.prepare('SELECT * FROM tv_releases WHERE guid = ?').get(item.guid) as any;
    if (tvRelease) {
      db.prepare(`
        UPDATE tv_releases 
        SET tvdb_id = ?, tvdb_slug = ?, tmdb_id = ?, imdb_id = ?, tvdb_poster_url = ?, tmdb_poster_url = ?, last_checked_at = datetime('now')
        WHERE guid = ?
      `).run(parseInt(tvdbId, 10), tvdbSlug, tmdbId || null, imdbId || null, tvdbPosterUrl, tmdbPosterUrl, item.guid);
      
      // Update all other tv_releases with the same TVDB ID to have the slug and poster URLs
      if (tvdbSlug || tvdbPosterUrl || tmdbPosterUrl) {
        const updateFields: string[] = [];
        const updateValues: any[] = [];
        
        if (tvdbSlug) {
          updateFields.push('tvdb_slug = ?');
          updateValues.push(tvdbSlug);
        }
        if (tvdbPosterUrl) {
          updateFields.push('tvdb_poster_url = ?');
          updateValues.push(tvdbPosterUrl);
        }
        if (tmdbPosterUrl) {
          updateFields.push('tmdb_poster_url = ?');
          updateValues.push(tmdbPosterUrl);
        }
        
        if (updateFields.length > 0) {
          updateValues.push(parseInt(tvdbId, 10));
          const updateCount = db.prepare(`
            UPDATE tv_releases 
            SET ${updateFields.join(', ')}
            WHERE tvdb_id = ? AND guid != ?
          `).run(...updateValues, item.guid).changes || 0;
          
          if (updateCount > 0) {
            console.log(`Updated ${updateCount} additional tv_release(s) with slug/posters`);
          }
        }
      }
      
      console.log(`Updated tv_release with TVDB ID ${tvdbId}, slug: ${tvdbSlug || 'none'}, posters: ${tvdbPosterUrl ? 'TVDB' : ''} ${tmdbPosterUrl ? 'TMDB' : ''}`);
    } else {
      // Update all existing tv_releases with the same TVDB ID to have the slug and poster URLs
      if (tvdbSlug || tvdbPosterUrl || tmdbPosterUrl) {
        const updateFields: string[] = [];
        const updateValues: any[] = [];
        
        if (tvdbSlug) {
          updateFields.push('tvdb_slug = ?');
          updateValues.push(tvdbSlug);
        }
        if (tvdbPosterUrl) {
          updateFields.push('tvdb_poster_url = ?');
          updateValues.push(tvdbPosterUrl);
        }
        if (tmdbPosterUrl) {
          updateFields.push('tmdb_poster_url = ?');
          updateValues.push(tmdbPosterUrl);
        }
        
        if (updateFields.length > 0) {
          updateValues.push(parseInt(tvdbId, 10));
          const updateCount = db.prepare(`
            UPDATE tv_releases 
            SET ${updateFields.join(', ')}
            WHERE tvdb_id = ?
          `).run(...updateValues).changes || 0;
          
          if (updateCount > 0) {
            console.log(`Updated ${updateCount} tv_release(s) with slug/posters`);
          }
        }
      }
      console.log(`No tv_release found for guid ${item.guid}, slug/posters will be set when release is processed`);
    }

    const seriesName = (tvdbSeries as any).name || (tvdbSeries as any).title || 'Unknown Series';
    console.log(`Manually updated RSS item ${itemId} with TVDB ID ${tvdbId} (${seriesName})`);

    res.json({ 
      success: true, 
      message: `TVDB ID updated to ${tvdbId} (${seriesName})`,
      tvdbId: parseInt(tvdbId, 10),
      tmdbId: tmdbId,
      imdbId: imdbId,
      seriesName: seriesName,
    });
  } catch (error: any) {
    console.error('Override TVDB ID for RSS item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to override TVDB ID: ' + (error?.message || 'Unknown error')
    });
  }
});

// Override IMDB ID for RSS item
router.post('/rss/override-imdb/:id', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    const { imdbId, action } = req.body as { imdbId?: string; action?: string };
    
    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    if (action === 'clear') {
      db.prepare(`
        UPDATE rss_feed_items
        SET imdb_id = NULL, imdb_id_manual = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(itemId);

      console.log(`Cleared IMDB ID for RSS item ${itemId}`);

      return res.json({
        success: true,
        message: 'IMDB ID cleared. This item will remain unmatched until you set a new ID manually.',
      });
    }
    
    if (!imdbId || !imdbId.match(/^tt\d{7,}$/)) {
      return res.status(400).json({ success: false, error: 'Valid IMDB ID is required (format: tt1234567)' });
    }

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    
    let tmdbId = item.tmdb_id;
    let tmdbTitle: string | undefined;

    // Try to get TMDB ID from IMDB ID if we have TMDB API key
    // Note: It's OK if TMDB doesn't exist for this IMDB ID - we'll just save the IMDB ID
    if (tmdbApiKey && !tmdbId) {
      tmdbClient.setApiKey(tmdbApiKey);
      try {
        const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
        if (tmdbMovie) {
          tmdbId = tmdbMovie.id;
          tmdbTitle = tmdbMovie.title;
          console.log(`Found TMDB ID ${tmdbId} for IMDB ${imdbId}: "${tmdbTitle}"`);
        } else {
          console.log(`TMDB entry does not exist for IMDB ${imdbId} - will save IMDB ID only`);
        }
      } catch (error: any) {
        // It's OK if TMDB doesn't exist - we'll just save the IMDB ID
        console.log(`Could not find TMDB ID for IMDB ${imdbId}: ${error?.message || 'Not found'}`);
      }
    }

    // Update the RSS item with the new IMDB ID and TMDB ID (if found), mark as manually set
    // Only mark tmdb_id_manual if we actually found a TMDB ID
    db.prepare(`
      UPDATE rss_feed_items 
      SET imdb_id = ?, tmdb_id = ?, imdb_id_manual = 1, tmdb_id_manual = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(imdbId, tmdbId || null, tmdbId ? 1 : 0, itemId);

    console.log(`Manually updated RSS item ${itemId} with IMDB ID ${imdbId}${tmdbId ? ` and TMDB ID ${tmdbId}` : ' (TMDB not found)'}`);

    res.json({ 
      success: true, 
      message: `IMDB ID updated to ${imdbId}${tmdbTitle ? ` (${tmdbTitle})` : ''}${tmdbId ? ` - TMDB: ${tmdbId}` : ' - TMDB entry not found'}`,
      imdbId: imdbId,
      tmdbId: tmdbId || null,
      tmdbTitle: tmdbTitle,
    });
  } catch (error: any) {
    console.error('Override IMDB ID for RSS item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to override IMDB ID: ' + (error?.message || 'Unknown error')
    });
  }
});

// Get match info for single RSS item (for match dialog)
router.get('/rss/match-info/:id', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    
    // Get the RSS item from database with feed type
    const item = db.prepare(`
      SELECT 
        rss.*,
        f.feed_type,
        COALESCE(rss.tvdb_id, tv.tvdb_id) as tvdb_id,
        tv.tvdb_slug,
        tv.show_name,
        tv.season_number
      FROM rss_feed_items rss
      LEFT JOIN rss_feeds f ON rss.feed_id = f.id
      LEFT JOIN tv_releases tv ON rss.guid = tv.guid
      WHERE rss.id = ?
    `).get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }
    
    // For TV shows, prefer show_name over clean_title (which is often null for TV)
    // For movies, use clean_title or normalized_title
    let displayTitle: string | null = null;
    let displayYear: number | null = item.year;
    
    if (item.feed_type === 'tv') {
      // TV shows: use show_name from tv_releases if available (this is the parsed/sanitized show name)
      // Otherwise fall back to clean_title, or parse from title
      displayTitle = item.show_name || item.clean_title || null;
      
      // If year is not set, try to extract it from title using parseTvTitle
      if (displayYear === null && item.title) {
        const { parseTvTitle } = await import('../services/tvMatchingEngine');
        const parsedTv = parseTvTitle(item.title);
        if (parsedTv.year) displayYear = parsedTv.year;
        if (!displayTitle) displayTitle = parsedTv.showName;
      }
      
      if (!displayTitle && item.title) {
        // Fallback: parse show name from title (basic cleanup similar to parseTvTitle)
        let parsed = item.title
          .replace(/\./g, ' ') // Replace dots with spaces
          .replace(/\s+/g, ' ') // Normalize spaces
          .trim();
        // Remove season/episode patterns for cleaner display (S01, S1E1, Season 1, etc.)
        parsed = parsed.replace(/\s*[Ss](\d+)(?:[Ee]\d+)?\s*/g, ' ');
        parsed = parsed.replace(/\s*[Ss]eason\s*(\d+)\s*/gi, ' ');
        // Remove year patterns
        parsed = parsed.replace(/[\(\[](19|20)\d{2}[\)\]]/g, '');
        parsed = parsed.replace(/\b(19|20)\d{2}\b/g, '');
        displayTitle = parsed.trim();
      }
    } else {
      // Movies: use clean_title (which is sanitized during RSS sync) or normalized_title
      displayTitle = item.clean_title || item.normalized_title || item.title || null;
    }
    
    res.json({ 
      success: true, 
      item: {
        id: item.id,
        title: item.title,
        clean_title: displayTitle, // Use the computed display title for the dialog
        normalized_title: item.normalized_title,
        year: displayYear, // Use extracted year for TV shows
        tmdb_id: item.tmdb_id,
        imdb_id: item.imdb_id,
        tvdb_id: item.tvdb_id,
        feed_type: item.feed_type,
        show_name: item.show_name,
        season_number: item.season_number,
      }
    });
  } catch (error: any) {
    console.error('Get match info error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get match info: ' + (error?.message || 'Unknown error') 
    });
  }
});

// Search for matches (returns candidates without applying)
router.post('/rss/search/:id', async (req: Request, res: Response) => {
  const itemId = parseInt(req.params.id, 10);
  try {
    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    // Get feed type
    const feed = db.prepare('SELECT feed_type FROM rss_feeds WHERE id = ?').get(item.feed_id) as any;
    const feedType = feed?.feed_type || 'movie';

    // Get match parameters from request body
    const matchParams = (req.body as Record<string, any>) || {};
    const userTitle: string | null = typeof matchParams.title === 'string' && matchParams.title.trim() ? matchParams.title.trim() : null;
    const userYear: number | null = typeof matchParams.year === 'number' ? matchParams.year : null;
    const userTmdbId: number | null = typeof matchParams.tmdbId === 'number' ? matchParams.tmdbId : null;
    const userTvdbId: number | null = typeof matchParams.tvdbId === 'number' ? matchParams.tvdbId : null;
    const userShowName: string | null = typeof matchParams.showName === 'string' && matchParams.showName.trim() ? matchParams.showName.trim() : null;

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    
    if (tmdbApiKey) tmdbClient.setApiKey(tmdbApiKey);

    let searchTitle: string | null = null;
    let searchYear: number | null = null;
    const candidates: any[] = [];

    if (feedType === 'tv') {
      // For TV shows
      if (userTvdbId) {
        // If TVDB ID is provided, fetch that specific series
        try {
          tvdbClient.updateConfig();
          const series = await tvdbClient.getSeriesExtended(userTvdbId);
          if (series) {
            const seriesData = series as any;
            candidates.push({
              tvdbId: userTvdbId,
              tvdbSlug: seriesData.slug || seriesData.nameSlug || null,
              name: seriesData.name || seriesData.title || 'Unknown Series',
              year: seriesData.year || seriesData.first_air_time ? new Date(seriesData.first_air_time).getFullYear() : null,
              overview: seriesData.overview || seriesData.description || null,
              poster: seriesData.poster || (seriesData.artwork && Array.isArray(seriesData.artwork) ? seriesData.artwork.find((a: any) => a.type === 2 || a.imageType === 'poster')?.image : null) || null,
              tmdbId: seriesData.remoteIds?.find((r: any) => r.sourceName === 'TheMovieDB.com')?.id || null,
              imdbId: seriesData.remoteIds?.find((r: any) => r.sourceName === 'IMDB')?.id || null,
            });
          }
        } catch (error) {
          console.error('Error fetching TVDB series:', error);
        }
      } else if (userShowName) {
        // Search TVDB
        searchTitle = userShowName;
        if (tvdbApiKey) {
          try {
            tvdbClient.updateConfig();
            const tvdbResults = await tvdbClient.searchSeries(userShowName);
            for (const series of tvdbResults.slice(0, 10)) {
              const seriesId = series.tvdb_id || series.id;
              if (seriesId) {
                try {
                  const seriesExtended = await tvdbClient.getSeriesExtended(seriesId);
                  if (seriesExtended) {
                    const seriesData = seriesExtended as any;
                    candidates.push({
                      tvdbId: seriesId,
                      tvdbSlug: seriesData.slug || seriesData.nameSlug || null,
                      name: seriesData.name || seriesData.title || 'Unknown Series',
                      year: seriesData.year || seriesData.first_air_time ? new Date(seriesData.first_air_time).getFullYear() : null,
                      overview: seriesData.overview || seriesData.description || null,
                      poster: seriesData.poster || (seriesData.artwork && Array.isArray(seriesData.artwork) ? seriesData.artwork.find((a: any) => a.type === 2 || a.imageType === 'poster')?.image : null) || null,
                      tmdbId: seriesData.remoteIds?.find((r: any) => r.sourceName === 'TheMovieDB.com')?.id || null,
                      imdbId: seriesData.remoteIds?.find((r: any) => r.sourceName === 'IMDB')?.id || null,
                    });
                  }
                } catch (error) {
                  // Skip this series if extended fetch fails
                }
              }
            }
          } catch (error) {
            console.error('Error searching TVDB:', error);
          }
        }

        // Also search TMDB for TV shows
        if (tmdbApiKey && candidates.length < 10) {
          try {
            const tmdbResults = await tmdbClient.searchTv(userShowName);
            for (const show of tmdbResults.slice(0, 10 - candidates.length)) {
              // Check if we already have this in candidates (by TMDB ID)
              if (!candidates.find(c => c.tmdbId === show.id)) {
                candidates.push({
                  tmdbId: show.id,
                  name: show.name || 'Unknown Series',
                  year: show.first_air_date ? new Date(show.first_air_date).getFullYear() : null,
                  overview: show.overview || null,
                  poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
                });
              }
            }
          } catch (error) {
            console.error('Error searching TMDB TV:', error);
          }
        }
      }
    } else {
      // For movies
      if (userTmdbId) {
        // If TMDB ID is provided, fetch that specific movie
        try {
          const movie = await tmdbClient.getMovie(userTmdbId);
          if (movie) {
            candidates.push({
              tmdbId: movie.id,
              title: movie.title || 'Unknown Movie',
              year: movie.release_date ? new Date(movie.release_date).getFullYear() : null,
              overview: null, // TMDB getMovie doesn't return overview, would need to fetch details
              poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
              imdbId: movie.imdb_id || null,
            });
          }
        } catch (error) {
          console.error('Error fetching TMDB movie:', error);
        }
      } else if (userTitle) {
        // Search TMDB for movies
        searchTitle = userTitle;
        searchYear = userYear;
        if (tmdbApiKey) {
          try {
            const movies = await tmdbClient.searchMovies(userTitle, userYear || undefined, 10);
            for (const movie of movies) {
              // Use overview from search result (TMDB search API includes overview)
              const overview = movie.overview || null;
              const imdbId = movie.imdb_id || null;
              
              candidates.push({
                tmdbId: movie.id,
                title: movie.title || 'Unknown Movie',
                year: movie.release_date ? new Date(movie.release_date).getFullYear() : null,
                overview: overview,
                poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                imdbId: imdbId,
              });
            }
          } catch (error) {
            console.error('Error searching TMDB movies:', error);
          }
        }
      }
    }

    res.json({
      success: true,
      query: searchTitle,
      year: searchYear,
      candidates: candidates,
      count: candidates.length,
    });
  } catch (error: any) {
    console.error('Search RSS item error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search: ' + (error?.message || 'Unknown error')
    });
  }
});

// Match single RSS item
router.post('/rss/match/:id', async (req: Request, res: Response) => {
  const itemId = parseInt(req.params.id, 10);
  try {
    
    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    console.log(`Manual match triggered for RSS item: "${item.title}" (ID: ${itemId})`);

    // Get match parameters from request body (if provided from dialog)
    const matchParams = (req.body as Record<string, any>) || {};
    const userTitle: string | null = typeof matchParams.title === 'string' && matchParams.title.trim() ? matchParams.title.trim() : null;
    const userYear: number | null = typeof matchParams.year === 'number' ? matchParams.year : null;
    const userTmdbId: number | null = typeof matchParams.tmdbId === 'number' ? matchParams.tmdbId : null;
    const userImdbId: string | null = typeof matchParams.imdbId === 'string' && matchParams.imdbId.trim() ? matchParams.imdbId.trim() : null;
    const userTvdbId: number | null = typeof matchParams.tvdbId === 'number' ? matchParams.tvdbId : null;
    const userShowName: string | null = typeof matchParams.showName === 'string' && matchParams.showName.trim() ? matchParams.showName.trim() : null;
    const userSeason: number | null = typeof matchParams.season === 'number' ? matchParams.season : null;

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key')?.value;
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    
    if (tmdbApiKey) tmdbClient.setApiKey(tmdbApiKey);
    if (omdbApiKey) imdbClient.setApiKey(omdbApiKey);
    if (braveApiKey) braveClient.setApiKey(braveApiKey);

    // Get feed type
    const feed = db.prepare('SELECT feed_type FROM rss_feeds WHERE id = ?').get(item.feed_id) as any;
    const feedType = feed?.feed_type || 'movie';

    // Use user-provided values or fall back to existing/parsed values
    let tmdbId = userTmdbId !== null ? userTmdbId : (item.tmdb_id || null);
    let imdbId = userImdbId !== null ? userImdbId : (item.imdb_id || null);
    let tvdbId = userTvdbId !== null ? userTvdbId : (item.tvdb_id || null);
    let showName = userShowName !== null ? userShowName : null;
    let season = userSeason !== null ? userSeason : null;
    let year = userYear !== null ? userYear : null;
    let cleanTitle = userTitle !== null ? userTitle : null;
    let parsed: any = null; // Will be set for movies
    
    if (feedType === 'tv') {
      // For TV shows, use parseTvTitle to extract show name, season, and year
      const { parseTvTitle } = await import('../services/tvMatchingEngine');
      const parsedTv = parseTvTitle(item.title);
      
      if (!showName) showName = parsedTv.showName;
      if (season === null) season = parsedTv.season;
      if (year === null) year = parsedTv.year;
      
      // Use showName as cleanTitle for TV shows
      if (!cleanTitle) cleanTitle = showName;
    } else {
      // For movies, use parseRSSItem
      parsed = parseRSSItem({
        title: item.title,
        link: item.link,
        guid: item.guid,
        description: item.raw_data || '',
      } as any, item.feed_id, item.feed_name);
      
      if (!tmdbId) tmdbId = (parsed as any).tmdb_id || item.tmdb_id || null;
      if (!imdbId) imdbId = (parsed as any).imdb_id || item.imdb_id || null;
      if (!cleanTitle) cleanTitle = (parsed as any).clean_title || item.clean_title || null;
      if (year === null) year = parsed.year || item.year || null;
    }

    console.log(`  Match attributes: Title="${cleanTitle}", Year=${year || 'none'}, TMDB=${tmdbId || 'none'}, IMDB=${imdbId || 'none'}, TVDB=${tvdbId || 'none'}`);
    if (feedType === 'tv') {
      console.log(`  TV attributes: Show="${showName || 'none'}", Season=${season !== null ? season : 'none'}`);
    }

    // Step 0: Validate existing TMDB/IMDB ID pair if both are present
    if (tmdbId && imdbId && tmdbApiKey) {
      try {
        console.log(`    Validating TMDB ID ${tmdbId} and IMDB ID ${imdbId} match...`);
        const tmdbMovie = await tmdbClient.getMovie(tmdbId);
        const tmdbImdbId = tmdbMovie?.imdb_id;
        
        if (tmdbImdbId && tmdbImdbId !== imdbId) {
          console.log(`    ⚠ MISMATCH DETECTED: TMDB ${tmdbId} has IMDB ${tmdbImdbId}, but we have IMDB ${imdbId}`);
          console.log(`    TMDB movie: "${tmdbMovie?.title}" (${tmdbMovie?.release_date ? new Date(tmdbMovie.release_date).getFullYear() : 'unknown'})`);
          
          // Try to get TMDB ID from the IMDB ID we have
          try {
            const correctTmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
            if (correctTmdbMovie) {
              const correctTmdbId = correctTmdbMovie.id;
              const correctYear = correctTmdbMovie.release_date ? new Date(correctTmdbMovie.release_date).getFullYear() : null;
              console.log(`    ✓ Found TMDB ID ${correctTmdbId} for IMDB ${imdbId}: "${correctTmdbMovie.title}" (${correctYear || 'unknown'})`);
              
              // Validate year match if we have a year
              if (year && correctYear && correctYear === year) {
                console.log(`    ✓ Year matches (${year}) - using correct TMDB ID ${correctTmdbId}`);
                tmdbId = correctTmdbId;
              } else if (!year || !correctYear) {
                // If we don't have year info, trust the IMDB match
                console.log(`    ⚠ No year validation possible - using TMDB ID ${correctTmdbId} from IMDB ${imdbId}`);
                tmdbId = correctTmdbId;
              } else {
                console.log(`    ⚠ Year mismatch: expected ${year}, got ${correctYear} - keeping original TMDB ID ${tmdbId}`);
              }
            } else {
              console.log(`    ⚠ Could not find TMDB ID for IMDB ${imdbId} - keeping original TMDB ID ${tmdbId}`);
            }
          } catch (error) {
            console.log(`    ⚠ Failed to validate IMDB ${imdbId} - keeping original TMDB ID ${tmdbId}`);
          }
        } else if (tmdbImdbId === imdbId) {
          console.log(`    ✓ TMDB ${tmdbId} and IMDB ${imdbId} match correctly`);
        } else if (!tmdbImdbId) {
          console.log(`    ⚠ TMDB ${tmdbId} has no IMDB ID - cannot validate match`);
        }
      } catch (error) {
        console.log(`    ⚠ Failed to validate TMDB/IMDB pair:`, error);
      }
    }

    // Run enrichment logic (same as in rssSync.ts)
    const needsEnrichment = !tmdbId || !imdbId;

    if (needsEnrichment) {
      // Step 1: If we have IMDB ID but no TMDB ID
      if (!tmdbId && imdbId && tmdbApiKey) {
        try {
          console.log(`    Looking up TMDB ID for IMDB ID ${imdbId}`);
          const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
          if (tmdbMovie) {
            tmdbId = tmdbMovie.id;
            console.log(`    ✓ Found TMDB ID ${tmdbId} for IMDB ID ${imdbId}`);
          }
        } catch (error) {
          console.log(`    ✗ Failed to find TMDB ID for IMDB ID ${imdbId}:`, error);
        }
      }

      // Step 2: If we don't have IMDB ID, try OMDB
      if (!imdbId && cleanTitle && (omdbApiKey || true)) {
        try {
          console.log(`    Searching IMDB (OMDB) for: "${cleanTitle}" ${year ? `(${year})` : ''}`);
          const imdbResult = await imdbClient.searchMovie(cleanTitle, year || undefined);
          if (imdbResult) {
            imdbId = imdbResult.imdbId;
            console.log(`    ✓ Found IMDB ID ${imdbId} for "${cleanTitle}" (OMDB returned: "${imdbResult.title}" ${imdbResult.year})`);
            
            if (!tmdbId && tmdbApiKey) {
              try {
                const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                if (tmdbMovie) {
                  tmdbId = tmdbMovie.id;
                  console.log(`    ✓ Found TMDB ID ${tmdbId} from IMDB ID ${imdbId}`);
                }
              } catch (error) {
                console.log(`    ✗ Failed to get TMDB ID from IMDB ID ${imdbId}:`, error);
              }
            }
          } else {
            console.log(`    ✗ OMDB search returned no results for "${cleanTitle}" ${year ? `(${year})` : ''}`);
          }
        } catch (error: any) {
          console.log(`    ✗ Failed to find IMDB ID via OMDB for "${cleanTitle}":`, error?.message || error);
        }
      }

      // Step 2b: Try Brave Search for IMDB ID
      if (!imdbId && cleanTitle && braveApiKey) {
        try {
          const braveImdbId = await braveClient.searchForImdbId(cleanTitle, year || undefined);
          if (braveImdbId) {
            imdbId = braveImdbId;
            if (!tmdbId && tmdbApiKey) {
              try {
                const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                if (tmdbMovie) {
                  tmdbId = tmdbMovie.id;
                  console.log(`    ✓ Found TMDB ID ${tmdbId} from IMDB ID ${imdbId}`);
                }
              } catch (error) {
                // Ignore
              }
            }
          }
        } catch (error: any) {
          if (error?.message === 'BRAVE_RATE_LIMITED') {
            console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for this item.`);
          } else {
            console.log(`    ✗ Failed to find IMDB ID via Brave for "${cleanTitle}":`, error);
          }
        }
      }

      // Step 3: Try TMDB search
      if (!tmdbId && cleanTitle && tmdbApiKey) {
        try {
          console.log(`    Searching TMDB for: "${cleanTitle}" ${year ? `(${year})` : ''}`);
          const tmdbMovie = await tmdbClient.searchMovie(cleanTitle, year || undefined);
          if (tmdbMovie) {
            console.log(`    TMDB search returned: "${tmdbMovie.title}" (ID: ${tmdbMovie.id}, Year: ${tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : 'unknown'})`);
            let isValidMatch = true;
            if (year && tmdbMovie.release_date) {
              const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
              if (releaseYear !== year) {
                isValidMatch = false;
                console.log(`    ✗ TMDB result year mismatch: ${releaseYear} vs ${year} - rejecting match`);
              }
            }
            
            if (isValidMatch) {
              tmdbId = tmdbMovie.id;
              console.log(`    ✓ Found TMDB ID ${tmdbId} for "${cleanTitle}"`);
              
              if (!imdbId && tmdbMovie.imdb_id) {
                imdbId = tmdbMovie.imdb_id;
                console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie`);
              }
            }
          } else {
            console.log(`    ✗ TMDB search returned no results for "${cleanTitle}" ${year ? `(${year})` : ''}`);
          }
        } catch (error: any) {
          console.log(`    ✗ Failed to find TMDB ID for "${cleanTitle}":`, error?.message || error);
        }
      }

      // Step 3b: Try normalized title (movies only)
      if (!tmdbId && tmdbApiKey && parsed && (parsed as any).normalized_title && (parsed as any).normalized_title !== cleanTitle) {
        const normalizedTitle = (parsed as any).normalized_title;
        try {
          console.log(`    Searching TMDB (normalized) for: "${normalizedTitle}" ${year ? `(${year})` : ''}`);
          const tmdbMovie = await tmdbClient.searchMovie(normalizedTitle, year || undefined);
          if (tmdbMovie) {
            let isValidMatch = true;
            if (year && tmdbMovie.release_date) {
              const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
              if (releaseYear !== year) {
                isValidMatch = false;
                console.log(`    ✗ TMDB normalized title result year mismatch: ${releaseYear} vs ${year}`);
              }
            }
            if (isValidMatch) {
              tmdbId = tmdbMovie.id;
              console.log(`    ✓ Found TMDB ID ${tmdbId} for normalized title "${normalizedTitle}"`);
              if (!imdbId && tmdbMovie.imdb_id) {
                imdbId = tmdbMovie.imdb_id;
                console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie (normalized title)`);
              }
            }
          }
        } catch (error) {
          console.log(`    ✗ Failed to find TMDB ID for normalized title "${normalizedTitle}":`, error);
        }
      }

      // Step 3c: Try Brave Search for TMDB ID
      if (!tmdbId && cleanTitle && braveApiKey) {
        try {
          const braveTmdbId = await braveClient.searchForTmdbId(cleanTitle, year || undefined);
          if (braveTmdbId) {
            tmdbId = braveTmdbId;
            if (!imdbId && tmdbApiKey) {
              try {
                const tmdbMovie = await tmdbClient.getMovie(tmdbId);
                if (tmdbMovie && tmdbMovie.imdb_id) {
                  imdbId = tmdbMovie.imdb_id;
                  console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie ${tmdbId}`);
                }
              } catch (error) {
                // Ignore
              }
            }
          }
        } catch (error: any) {
          if (error?.message === 'BRAVE_RATE_LIMITED') {
            console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for this item.`);
          } else {
            console.log(`    ✗ Failed to find TMDB ID via Brave for "${cleanTitle}":`, error);
          }
        }
      }
    }

    // For TV shows, handle TVDB ID and show name
    if (feedType === 'tv' && tvdbId) {
      // Update TVDB ID if provided
      db.prepare(`
        UPDATE rss_feed_items 
        SET tvdb_id = ?, tvdb_id_manual = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(tvdbId, itemId);
      
      // Propagate TVDB/TMDB/IMDB IDs to all other RSS items for the same TV show
      const allRssItemsWithSameTvdb = db.prepare(`
        SELECT id FROM rss_feed_items 
        WHERE tvdb_id = ? AND id != ? AND feed_id IN (SELECT id FROM rss_feeds WHERE feed_type = 'tv')
      `).all(tvdbId, itemId) as any[];
      
      let propagatedCount = 0;
      for (const otherItem of allRssItemsWithSameTvdb) {
        const otherItemFull = db.prepare('SELECT tvdb_id_manual FROM rss_feed_items WHERE id = ?').get(otherItem.id) as any;
        if (!otherItemFull?.tvdb_id_manual) {
          db.prepare(`
            UPDATE rss_feed_items 
            SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(tvdbId, tmdbId || null, imdbId || null, otherItem.id);
          propagatedCount++;
        }
      }
      
      // Also propagate by show name (for items that don't have TVDB ID yet)
      if (showName && showName.length > 2) {
        const { parseTvTitle } = await import('../services/tvMatchingEngine');
        const showNameForMatching = showName.toLowerCase().trim();
        const allTvRssItems = db.prepare(`
          SELECT rss.*, f.feed_type
          FROM rss_feed_items rss
          LEFT JOIN rss_feeds f ON rss.feed_id = f.id
          WHERE f.feed_type = 'tv' AND rss.id != ? AND (rss.tvdb_id IS NULL OR rss.tvdb_id != ?)
        `).all(itemId, tvdbId) as any[];
        
        for (const otherItem of allTvRssItems) {
          const otherParsed = parseTvTitle(otherItem.title);
          const otherShowName = otherParsed.showName.toLowerCase().trim();
          
          if (otherShowName === showNameForMatching || 
              (showNameForMatching.length > 3 && otherShowName.includes(showNameForMatching)) ||
              (otherShowName.length > 3 && showNameForMatching.includes(otherShowName))) {
            const hasManualTvdb = otherItem.tvdb_id_manual;
            if (!hasManualTvdb) {
              db.prepare(`
                UPDATE rss_feed_items 
                SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
                WHERE id = ?
              `).run(tvdbId, tmdbId || null, imdbId || null, otherItem.id);
              propagatedCount++;
            }
          }
        }
      }
      
      if (propagatedCount > 0) {
        console.log(`  ✓ Propagated IDs to ${propagatedCount} additional RSS item(s) for the same show`);
      }
      
      // Also update tv_releases if it exists
      const tvRelease = db.prepare('SELECT * FROM tv_releases WHERE guid = ?').get(item.guid) as any;
      if (tvRelease) {
        // Fetch TVDB extended info to get slug and poster
        let tvdbSlug: string | null = null;
        let tvdbPosterUrl: string | null = null;
        
        if (tvdbApiKey) {
          try {
            tvdbClient.updateConfig();
            const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
            if (tvdbExtended) {
              tvdbSlug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || null;
              const artwork = (tvdbExtended as any).artwork || (tvdbExtended as any).artworks;
              if (artwork && Array.isArray(artwork)) {
                const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster');
                if (poster) {
                  tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
                }
              }
            }
          } catch (error) {
            console.log(`  ⚠ Failed to fetch TVDB extended info:`, error);
          }
        }
        
        db.prepare(`
          UPDATE tv_releases 
          SET tvdb_id = ?, tvdb_slug = ?, last_checked_at = datetime('now')
          WHERE guid = ?
        `).run(tvdbId, tvdbSlug, item.guid);
      }
    }

    // Update the database with found IDs
    const updates: string[] = [];
    const updateValues: any[] = [];
    
    if (tmdbId !== item.tmdb_id) {
      updates.push('tmdb_id = ?');
      updateValues.push(tmdbId);
    }
    if (imdbId !== item.imdb_id) {
      updates.push('imdb_id = ?');
      updateValues.push(imdbId);
    }
    if (cleanTitle && cleanTitle !== item.clean_title) {
      updates.push('clean_title = ?');
      updateValues.push(cleanTitle);
    }
    if (year !== null && year !== item.year) {
      updates.push('year = ?');
      updateValues.push(year);
    }
    
    if (updates.length > 0) {
      updateValues.push(itemId);
      db.prepare(`
        UPDATE rss_feed_items 
        SET ${updates.join(', ')}, updated_at = datetime('now')
        WHERE id = ?
      `).run(...updateValues);
      
      console.log(`  ✓ Updated RSS item ${itemId}: TMDB=${tmdbId || 'null'}, IMDB=${imdbId || 'null'}, Title="${cleanTitle || 'null'}", Year=${year || 'null'}`);
    } else {
      console.log(`  ℹ No changes needed for RSS item ${itemId}`);
    }

    // After enrichment, trigger matching engine for this specific item
    try {
      if (feedType === 'tv') {
        console.log(`  [MATCH] Triggering TV matching engine for item ${itemId}...`);
        // For TV, we need to run the TV matching engine
        // It will process all items, but our enriched item will be included
        const tvStats = await runTvMatchingEngine();
        console.log(`  [MATCH] ✓ TV matching engine completed: ${tvStats.processed} processed, ${tvStats.newShows} new shows, ${tvStats.errors} errors`);
      } else {
        console.log(`  [MATCH] Triggering movie matching engine for item ${itemId}...`);
        // For movies, run the movie matching engine
        // It will process all items, but our enriched item will be included
        const movieStats = await runMatchingEngine();
        console.log(`  [MATCH] ✓ Movie matching engine completed: ${movieStats.processed} processed, ${movieStats.newReleases} new releases, ${movieStats.errors} errors`);
      }
    } catch (matchError: any) {
      console.error(`  [MATCH] ⚠ Matching engine error (enrichment still succeeded):`, matchError);
      console.error(`  [MATCH] Error details:`, matchError?.message || matchError?.toString() || 'Unknown error');
      // Don't fail the request if matching fails - enrichment succeeded
    }

    console.log(`  [MATCH] Final result: TMDB=${tmdbId || 'none'}, IMDB=${imdbId || 'none'}, TVDB=${tvdbId || 'none'}, Title="${cleanTitle || 'none'}", Year=${year || 'none'}`);
    
    const response: any = {
      success: true, 
      message: 'Match and enrichment completed',
      tmdbId,
      imdbId,
      title: cleanTitle,
      year: year,
    };
    if (feedType === 'tv' && tvdbId !== null) {
      response.tvdbId = tvdbId;
      response.showName = showName;
      response.season = season;
    }
    
    console.log(`  [MATCH] ✓ Match endpoint completed successfully for item ${itemId}`);
    res.json(response);
  } catch (error: any) {
    console.error(`  [MATCH] ✗ Match RSS item error for item ${itemId}:`, error);
    console.error(`  [MATCH] Error stack:`, error?.stack || 'No stack trace');
    res.status(500).json({ 
      success: false,
      error: 'Failed to match RSS item: ' + (error?.message || error?.toString() || 'Unknown error')
    });
  }
});

// Trigger Movie Matching Engine
router.post('/releases/match', async (req: Request, res: Response) => {
  try {
    // Check if matching is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'matching') {
      return res.json({ success: false, message: 'Movie matching engine is already running' });
    }

    // Start matching engine in background
    (async () => {
      try {
        console.log('Starting movie matching engine from Movie Releases page...');
        syncProgress.start('matching', 0);
        syncProgress.update('Starting movie matching engine...', 0);
        
        const stats = await runMatchingEngine();
        
        syncProgress.update('Movie matching completed', stats.processed, stats.processed, stats.errors);
        syncProgress.complete();
        
        console.log('Movie matching engine completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Movie matching engine error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Movie matching engine started' });
  } catch (error: any) {
    console.error('Start movie matching engine error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start movie matching engine',
      message: error?.message || 'Unknown error'
    });
  }
});

// Trigger TV Matching Engine
router.post('/tv-releases/match', async (req: Request, res: Response) => {
  try {
    // Check if matching is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'tv-matching') {
      return res.json({ success: false, message: 'TV matching engine is already running' });
    }

    // Start TV matching engine in background
    (async () => {
      try {
        console.log('Starting TV matching engine from TV Releases page...');
        syncProgress.start('tv-matching', 0);
        syncProgress.update('Starting TV matching engine...', 0);
        
        const stats = await runTvMatchingEngine();
        
        syncProgress.update('TV matching completed', stats.processed, stats.processed, stats.errors);
        syncProgress.complete();
        
        console.log('TV matching engine completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('TV matching engine error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'TV matching engine started' });
  } catch (error: any) {
    console.error('Start TV matching engine error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start TV matching engine',
      message: error?.message || 'Unknown error'
    });
  }
});

// Get matching engine progress
router.get('/releases/match/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({ success: true, progress });
  } catch (error) {
    console.error('Get matching engine progress error:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

router.get('/tv-releases/match/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({ success: true, progress });
  } catch (error) {
    console.error('Get TV matching engine progress error:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

// Backfill TVDB slugs for existing TV shows
router.post('/tv/backfill-slugs', async (req: Request, res: Response) => {
  try {
    console.log('TVDB slug backfill requested');
    
    // Run backfill asynchronously
    (async () => {
      try {
        const stats = await backfillTvdbSlugs();
        console.log('TVDB slug backfill completed:', stats);
      } catch (error: any) {
        console.error('TVDB slug backfill error:', error);
      }
    })();
    
    res.json({ 
      success: true, 
      message: 'TVDB slug backfill started. Check logs for progress.' 
    });
  } catch (error: any) {
    console.error('Start TVDB slug backfill error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start TVDB slug backfill',
      message: error?.message || 'Unknown error'
    });
  }
});

// Update TVDB slug for a specific TVDB ID (utility endpoint for manual fixes)
router.post('/tv/update-slug/:tvdbId', async (req: Request, res: Response) => {
  try {
    const tvdbId = parseInt(req.params.tvdbId, 10);
    
    if (!tvdbId || isNaN(tvdbId)) {
      return res.status(400).json({ success: false, error: 'Valid TVDB ID is required' });
    }

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    
    if (!tvdbApiKey) {
      return res.status(400).json({ success: false, error: 'TVDB API key not configured' });
    }

    tvdbClient.updateConfig();

    // Fetch extended info from TVDB API
    const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
    
    if (!tvdbExtended) {
      return res.status(404).json({ success: false, error: 'TVDB ID not found' });
    }

    // Extract slug from extended info
    const slug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
    
    if (!slug) {
      return res.status(404).json({ success: false, error: 'No slug found in TVDB API response' });
    }

    // Update all tv_releases with this TVDB ID
    const updateResult = db.prepare(`
      UPDATE tv_releases 
      SET tvdb_slug = ?
      WHERE tvdb_id = ?
    `).run(slug, tvdbId);
    
    const updated = updateResult.changes || 0;
    
    console.log(`Updated ${updated} tv_release(s) with TVDB ID ${tvdbId} to have slug: ${slug}`);

    res.json({ 
      success: true, 
      message: `Updated ${updated} release(s) with slug: ${slug}`,
      tvdbId,
      slug,
      updated,
    });
  } catch (error: any) {
    console.error('Update TVDB slug error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update TVDB slug: ' + (error?.message || 'Unknown error')
    });
  }
});

export default router;

