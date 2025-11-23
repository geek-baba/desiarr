import { Router, Request, Response } from 'express';
import { getSyncedRadarrMovies, getLastRadarrSync, syncRadarrMovies } from '../services/radarrSync';
import { getSyncedRssItems, getSyncedRssItemsByFeed, getLastRssSync, syncRssFeeds, backfillMissingIds } from '../services/rssSync';
import { feedsModel } from '../models/feeds';
import { syncProgress } from '../services/syncProgress';
import { logStorage } from '../services/logStorage';
import db from '../db';
import { parseRSSItem } from '../rss/parseRelease';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import braveClient from '../brave/client';
import { settingsModel } from '../models/settings';

const router = Router();

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
        } catch (error) {
          console.log(`    ✗ Failed to find IMDB ID via Brave for "${cleanTitle}":`, error);
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
        } catch (error) {
          console.log(`    ✗ Failed to find TMDB ID via Brave for "${cleanTitle}":`, error);
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

export default router;

