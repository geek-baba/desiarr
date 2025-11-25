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
        ORDER BY datetime(rss.published_at) DESC
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
        ORDER BY datetime(rss.published_at) DESC
      `).all(feedType);
    } else {
      items = db.prepare(`
        SELECT 
          rss.*,
          f.feed_type,
          COALESCE(rss.tvdb_id, tv.tvdb_id) as tvdb_id,
          tv.tvdb_slug
        FROM rss_feed_items rss
        LEFT JOIN rss_feeds f ON rss.feed_id = f.id
        LEFT JOIN tv_releases tv ON rss.guid = tv.guid
        ORDER BY datetime(rss.published_at) DESC
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
    const { tmdbId } = req.body;
    
    if (!tmdbId || isNaN(parseInt(tmdbId, 10))) {
      return res.status(400).json({ success: false, error: 'Valid TMDB ID is required' });
    }

    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
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
    const { tvdbId } = req.body;
    
    if (!tvdbId || isNaN(parseInt(tvdbId, 10))) {
      return res.status(400).json({ success: false, error: 'Valid TVDB ID is required' });
    }

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
    // Trigger authentication by making a request (ensureAuthHeaders will be called internally)
    // We'll verify the ID by calling getSeries which will authenticate automatically

    // Verify the TVDB ID by fetching series details
    const tvdbSeries = await tvdbClient.getSeries(parseInt(tvdbId, 10));
    if (!tvdbSeries) {
      return res.status(404).json({ success: false, error: 'TVDB ID not found' });
    }

    // Try to get TMDB and IMDB IDs from TVDB extended info
    let tmdbId = item.tmdb_id;
    let imdbId = item.imdb_id;
    
    try {
      const tvdbExtended = await tvdbClient.getSeriesExtended(parseInt(tvdbId, 10));
      if (tvdbExtended) {
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

    // Update the RSS item with the new TVDB ID and any found IDs, mark as manually set
    db.prepare(`
      UPDATE rss_feed_items 
      SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, tvdb_id_manual = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(parseInt(tvdbId, 10), tmdbId || null, imdbId || null, itemId);

    // Also update tv_releases if it exists
    const tvRelease = db.prepare('SELECT * FROM tv_releases WHERE guid = ?').get(item.guid) as any;
    if (tvRelease) {
      db.prepare(`
        UPDATE tv_releases 
        SET tvdb_id = ?, tmdb_id = ?, imdb_id = ?, last_checked_at = datetime('now')
        WHERE guid = ?
      `).run(parseInt(tvdbId, 10), tmdbId || null, imdbId || null, item.guid);
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
    const { imdbId } = req.body;
    
    if (!imdbId || !imdbId.match(/^tt\d{7,}$/)) {
      return res.status(400).json({ success: false, error: 'Valid IMDB ID is required (format: tt1234567)' });
    }

    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
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

// Match single RSS item
router.post('/rss/match/:id', async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    
    // Get the RSS item from database
    const item = db.prepare('SELECT * FROM rss_feed_items WHERE id = ?').get(itemId) as any;
    
    if (!item) {
      return res.status(404).json({ success: false, error: 'RSS item not found' });
    }

    console.log(`Manual match triggered for RSS item: "${item.title}" (ID: ${itemId})`);

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key')?.value;
    
    if (tmdbApiKey) tmdbClient.setApiKey(tmdbApiKey);
    if (omdbApiKey) imdbClient.setApiKey(omdbApiKey);
    if (braveApiKey) braveClient.setApiKey(braveApiKey);

    // Re-parse the item to get clean title
    const parsed = parseRSSItem({
      title: item.title,
      link: item.link,
      guid: item.guid,
      description: item.raw_data || '',
    } as any, item.feed_id, item.feed_name);

    let tmdbId = item.tmdb_id || (parsed as any).tmdb_id || null;
    let imdbId = item.imdb_id || (parsed as any).imdb_id || null;
    const cleanTitle = (parsed as any).clean_title || item.clean_title || null;
    const year = parsed.year || item.year || null;

    console.log(`  Current state: TMDB=${tmdbId || 'missing'}, IMDB=${imdbId || 'missing'}, Title="${cleanTitle}", Year=${year || 'none'}`);

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

      // Step 3b: Try normalized title
      if (!tmdbId && tmdbApiKey && parsed.normalized_title && parsed.normalized_title !== cleanTitle) {
        try {
          console.log(`    Searching TMDB (normalized) for: "${parsed.normalized_title}" ${year ? `(${year})` : ''}`);
          const tmdbMovie = await tmdbClient.searchMovie(parsed.normalized_title, year || undefined);
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
              console.log(`    ✓ Found TMDB ID ${tmdbId} for normalized title "${parsed.normalized_title}"`);
              if (!imdbId && tmdbMovie.imdb_id) {
                imdbId = tmdbMovie.imdb_id;
                console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie (normalized title)`);
              }
            }
          }
        } catch (error) {
          console.log(`    ✗ Failed to find TMDB ID for normalized title "${parsed.normalized_title}":`, error);
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

    // Update the database with found IDs
    if (tmdbId !== item.tmdb_id || imdbId !== item.imdb_id) {
      db.prepare(`
        UPDATE rss_feed_items 
        SET tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(tmdbId, imdbId, itemId);
      
      console.log(`  ✓ Updated RSS item ${itemId}: TMDB=${tmdbId || 'null'}, IMDB=${imdbId || 'null'}`);
    } else {
      console.log(`  ℹ No changes needed for RSS item ${itemId}`);
    }

    res.json({ 
      success: true, 
      message: 'Match completed',
      tmdbId,
      imdbId,
    });
  } catch (error: any) {
    console.error('Match RSS item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to match RSS item: ' + (error?.message || 'Unknown error') 
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

export default router;

