import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { feedsModel } from '../models/feeds';
import radarrClient from '../radarr/client';
import tmdbClient from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { config } from '../config';
import { Release } from '../types/Release';
import { getSyncedRadarrMovieByTmdbId, getSyncedRadarrMovieByRadarrId } from '../services/radarrSync';
import { runMatchingEngine } from '../services/matchingEngine';
import { syncProgress } from '../services/syncProgress';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';

const router = Router();

function sanitizeTitle(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a clean movie name + year from a normalized title by removing quality information.
 * This is used for matching releases that represent the same movie but with different quality.
 * 
 * Example:
 *   "nishaanchi 2 2025 1080p amzn web dl dd 5 1 atmos h 264 khn" 
 *   -> "nishaanchi 2 2025"
 */
function extractMovieNameAndYear(normalizedTitle: string, year?: number): string {
  // Start with the normalized title
  let clean = normalizedTitle.toLowerCase();
  
  // Remove year if it's embedded (we'll add it back at the end)
  clean = clean.replace(/\b(19|20)\d{2}\b/g, '');
  
  // Remove common quality/resolution patterns (with or without spaces)
  clean = clean.replace(/\b(2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd)\b/gi, '');
  
  // Remove codec patterns (handle spaces: "h 264", "h 265", "h264", "h.264", etc.)
  clean = clean.replace(/\b(x264|x265|h\s*\.?\s*264|h\s*\.?\s*265|h264|h265|hevc|avc)\b/gi, '');
  
  // Remove source tags (handle spaces: "web dl", "webdl", etc.)
  clean = clean.replace(/\b(amzn|netflix|nf|jc|jiocinema|zee5|dsnp|disney|hotstar|hs|ss|web\s*dl|webdl|webrip|bluray|dvdrip)\b/gi, '');
  
  // Remove audio patterns (handle spaces: "5 1", "5.1", "dd +", etc.)
  clean = clean.replace(/\b(dd\s*\+?\s*|ddp|eac3|ac3|atmos|truehd|dts|aac|stereo|5\s*\.?\s*1|7\s*\.?\s*1|2\s*\.?\s*0)\b/gi, '');
  
  // Remove common release group patterns (usually at the end: "dtr", "khn", "DTR-KHN", etc.)
  // Match 2-4 letter groups, optionally with dashes/underscores
  clean = clean.replace(/\b([a-z]{2,4}(?:[-_][a-z]{2,4})?)\b/gi, '');
  
  // Remove any remaining large numbers that are likely quality-related (like "264", "265", etc.)
  // But keep single digits that might be part of movie titles (like "Nishaanchi 2")
  clean = clean.replace(/\b\d{3,}\b/g, '');
  
  // Remove extra whitespace and trim
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // Add year back if provided
  if (year) {
    clean = `${clean} ${year}`;
  }
  
  return clean.trim();
}

function buildDisplayTitle(release: Release): string {
  if (release.radarr_movie_title) {
    return release.radarr_movie_title;
  }
  if (release.tmdb_title) {
    return release.tmdb_title;
  }
  const base = sanitizeTitle(release.title || '');
  if (release.year && !base.includes(release.year.toString())) {
    return `${base} (${release.year})`.trim();
  }
  return base || release.title || 'Unknown Title';
}

router.get('/', async (req: Request, res: Response) => {
  try {
    // Get TMDB API key from settings
    const settings = settingsModel.getAll();
    const tmdbApiKey = settings.find(s => s.key === 'tmdb_api_key')?.value;
    if (tmdbApiKey) {
      tmdbClient.setApiKey(tmdbApiKey);
    }

    // Get all releases
    const allReleases = releasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Get feed names for display
    const feedMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
      }
    }

    // Add feed names to releases
    for (const release of allReleases) {
      (release as any).feedName = feedMap[release.feed_id] || 'Unknown Feed';
    }

    // Group releases by movie (using TMDB ID as primary key, fallback to normalized title)
    // Two-pass approach: first group by ID, then merge title-based groups that match ID-based groups
    const releasesByMovie: { [key: string]: any[] } = {};
    const idToKeyMap: { [key: string]: string } = {}; // Map TMDB/Radarr IDs to their movieKey
    
    // First pass: Group releases that have TMDB or Radarr IDs
    for (const release of allReleases) {
      if (release.tmdb_id || release.radarr_movie_id) {
        let movieKey: string;
        if (release.tmdb_id) {
          movieKey = `tmdb_${release.tmdb_id}`;
          idToKeyMap[`tmdb_${release.tmdb_id}`] = movieKey;
        } else {
          movieKey = `radarr_${release.radarr_movie_id}`;
          idToKeyMap[`radarr_${release.radarr_movie_id}`] = movieKey;
        }
        
        if (!releasesByMovie[movieKey]) {
          releasesByMovie[movieKey] = [];
        }
        releasesByMovie[movieKey].push(release);
      }
    }
    
    // Second pass: For releases without IDs, try to match them to existing groups
    // by extracting clean movie name + year (without quality info) and matching
    for (const release of allReleases) {
      if (!release.tmdb_id && !release.radarr_movie_id) {
        const releaseMovieKey = extractMovieNameAndYear(release.normalized_title, release.year);
        const titleKey = `title_${releaseMovieKey}`;
        
        // Try to find a matching group by checking if any release in an existing group
        // has the same clean movie name + year (ignoring quality differences)
        let matched = false;
        for (const existingKey in releasesByMovie) {
          const existingReleases = releasesByMovie[existingKey];
          // Check if any release in this group has the same clean movie name + year
          const hasMatch = existingReleases.some(r => {
            const existingMovieKey = extractMovieNameAndYear(r.normalized_title, r.year);
            return existingMovieKey === releaseMovieKey;
          });
          
          if (hasMatch) {
            releasesByMovie[existingKey].push(release);
            matched = true;
            break;
          }
        }
        
        // If no match found, create a new group
        if (!matched) {
          if (!releasesByMovie[titleKey]) {
            releasesByMovie[titleKey] = [];
          }
          releasesByMovie[titleKey].push(release);
        }
      }
    }

    // Build movie groups with metadata
    const movieGroups: Array<{
      movieKey: string;
      movieTitle: string;
      tmdbId?: number;
      radarrMovieId?: number;
      posterUrl?: string;
      imdbId?: string;
      originalLanguage?: string;
      radarrInfo?: any;
      add: any[];
      existing: any[];
      upgrade: any[];
      ignored: any[];
    }> = [];

    for (const movieKey in releasesByMovie) {
      const releases = releasesByMovie[movieKey];
      
      // Get the primary movie info (prefer from existing/upgrade releases as they have more metadata)
      const primaryRelease = releases.find(r => r.radarr_movie_id) || 
                            releases.find(r => r.tmdb_id) || 
                            releases[0];
      
      const movieTitle = buildDisplayTitle(primaryRelease);

      const hasRadarrMatch = releases.some(r => Boolean(r.radarr_movie_id));
      
      // Categorize releases by state
      const upgrade = releases.filter(r => (
        r.radarr_movie_id &&
        (r.status === 'UPGRADE_CANDIDATE' || r.status === 'UPGRADED')
      ));
      const upgradeGuids = new Set(upgrade.map(r => r.guid));

      // Add releases: those without radarr_movie_id (includes NEW and ATTENTION_NEEDED)
      const add = hasRadarrMatch
        ? []
        : releases.filter(r => !r.radarr_movie_id && (r.status === 'NEW' || r.status === 'ATTENTION_NEEDED'));

      // Existing releases: those with radarr_movie_id but not upgrade candidates
      // Exclude IGNORED releases from existing (they'll be shown in Ignored tab)
      const existing = releases.filter(r => (
        !upgradeGuids.has(r.guid) &&
        (r.radarr_movie_id || hasRadarrMatch) &&
        r.status !== 'IGNORED' // Don't show ignored releases in existing section
      ));
      
      // Ignored releases: those with IGNORED status
      const ignored = releases.filter(r => r.status === 'IGNORED');
      
      // Extract Radarr info from synced Radarr movies table (more complete than release attributes)
      let radarrInfo: any = null;
      if (primaryRelease.radarr_movie_id) {
        const syncedRadarrMovie = getSyncedRadarrMovieByRadarrId(primaryRelease.radarr_movie_id);
        if (syncedRadarrMovie) {
          try {
            // Parse movie file for attributes
            if (syncedRadarrMovie.movie_file) {
              const movieFile = JSON.parse(syncedRadarrMovie.movie_file);
              radarrInfo = {
                path: syncedRadarrMovie.path,
                fileName: movieFile.relativePath ? movieFile.relativePath.split('/').pop() : null,
                resolution: movieFile.quality?.quality?.resolution || null,
                codec: null, // Will be parsed from filename
                sourceTag: movieFile.quality?.quality?.source || null,
                audio: null, // Will be parsed from filename
                sizeMb: movieFile.size ? movieFile.size / (1024 * 1024) : null,
                mediaInfo: movieFile.mediaInfo || null,
              };
              
              // Parse attributes from filename if available
              if (movieFile.relativePath) {
                const parsed = parseReleaseFromTitle(movieFile.relativePath);
                radarrInfo.codec = parsed.codec;
                radarrInfo.resolution = parsed.resolution || radarrInfo.resolution;
                radarrInfo.sourceTag = parsed.sourceTag || radarrInfo.sourceTag;
                radarrInfo.audio = parsed.audio;
              }
            }
            
            // Get last download from history stored in releases
            const releaseWithHistory = releases.find(r => r.radarr_history);
            if (releaseWithHistory && releaseWithHistory.radarr_history) {
              try {
                const history = JSON.parse(releaseWithHistory.radarr_history);
                if (Array.isArray(history) && history.length > 0) {
                  // Find the most recent download event
                  const downloadEvents = history.filter((h: any) => 
                    h.eventType === 'downloadFolderImported' || 
                    h.eventType === 'grabbed' ||
                    h.eventType === 'downloadCompleted'
                  );
                  if (downloadEvents.length > 0) {
                    // Sort by date, most recent first
                    downloadEvents.sort((a: any, b: any) => 
                      new Date(b.date).getTime() - new Date(a.date).getTime()
                    );
                    const lastDownload = downloadEvents[0];
                    radarrInfo.lastDownload = {
                      sourceTitle: lastDownload.sourceTitle || null,
                      date: lastDownload.date || null,
                      releaseGroup: lastDownload.data?.releaseGroup || null,
                    };
                  }
                }
              } catch (e) {
                console.error('Error parsing radarr_history:', e);
              }
            }
          } catch (e) {
            console.error('Error parsing Radarr movie file:', e);
          }
        }
      }
      
      // Fallback to existing_file_attributes if we don't have synced Radarr data
      if (!radarrInfo) {
        const releaseWithRadarrInfo = releases.find(r => r.existing_file_attributes);
        if (releaseWithRadarrInfo && releaseWithRadarrInfo.existing_file_attributes) {
          try {
            radarrInfo = JSON.parse(releaseWithRadarrInfo.existing_file_attributes);
          } catch (e) {
            console.error('Error parsing existing_file_attributes:', e);
          }
        }
      }
      
      // Extract IMDB ID from any release in the group
      const imdbIdFromRelease = releases.find(r => r.imdb_id)?.imdb_id;
      
      movieGroups.push({
        movieKey,
        movieTitle,
        tmdbId: primaryRelease.tmdb_id,
        radarrMovieId: primaryRelease.radarr_movie_id,
        imdbId: imdbIdFromRelease, // Add IMDB ID from releases
        radarrInfo, // Add Radarr info to the movie group
        add,
        existing,
        upgrade,
        ignored, // Add ignored releases
      });
    }

    // Enrich with movie metadata (poster, IMDB, etc.)
    for (const movieGroup of movieGroups) {
      // Get all releases for this movie group
      const groupReleases = releasesByMovie[movieGroup.movieKey] || [];
      
      // Get movie metadata if we have TMDB ID or Radarr movie ID
      if (movieGroup.tmdbId || movieGroup.radarrMovieId) {
        try {
          let movie: any = null;
          if (movieGroup.radarrMovieId) {
            // Use synced Radarr data instead of real-time API call
            const syncedMovie = getSyncedRadarrMovieByRadarrId(movieGroup.radarrMovieId);
            if (syncedMovie && syncedMovie.movie_file) {
              try {
                movie = { movieFile: JSON.parse(syncedMovie.movie_file) };
              } catch (error) {
                console.error('Error parsing synced movie file:', error);
              }
            }
          } else if (movieGroup.tmdbId) {
            // Use synced Radarr data instead of real-time API call
            const syncedMovie = getSyncedRadarrMovieByTmdbId(movieGroup.tmdbId);
            if (syncedMovie && syncedMovie.movie_file) {
              try {
                movie = { movieFile: JSON.parse(syncedMovie.movie_file) };
              } catch (error) {
                console.error('Error parsing synced movie file:', error);
              }
            }
          }
          
          if (movie) {
            if (movie.id) {
              movieGroup.radarrMovieId = movie.id;

              // Propagate Radarr linkage to releases so UI can show them under "Existing"
              for (const release of groupReleases) {
                if (!release.radarr_movie_id) {
                  release.radarr_movie_id = movie.id;
                  release.radarr_movie_title = movie.title;
                }
              }

              // If we previously categorized them as "Add", move them to "Existing"
              if (movieGroup.add.length > 0) {
                movieGroup.existing.push(...movieGroup.add);
                movieGroup.add = [];
              }
            }

            // Get poster URL (Radarr provides images array)
            if (movie.images && movie.images.length > 0) {
              const poster = movie.images.find((img: any) => img.coverType === 'poster');
              if (poster) {
                movieGroup.posterUrl = poster.remoteUrl || poster.url;
              }
            }
            
            // Get IMDB ID (prefer from Radarr, but also check releases)
            if (movie.imdbId) {
              movieGroup.imdbId = movie.imdbId;
            } else if (!movieGroup.imdbId) {
              // If not in Radarr, use IMDB ID from releases
              const releaseWithImdb = groupReleases.find((r: any) => r.imdb_id);
              if (releaseWithImdb?.imdb_id) {
                movieGroup.imdbId = releaseWithImdb.imdb_id;
              }
            }
            
            // Get TMDB ID (already have it, but ensure it's set)
            if (movie.tmdbId) {
              movieGroup.tmdbId = movie.tmdbId;
            }
            
            // Get original language
            if (movie.originalLanguage) {
              movieGroup.originalLanguage = movie.originalLanguage.name || movie.originalLanguage;
            }
          }
        } catch (error) {
          // Silently fail - just don't add metadata
          console.error(`Error fetching movie metadata for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      // If we still don't have IMDB ID, check releases directly
      if (!movieGroup.imdbId) {
        const releaseWithImdb = groupReleases.find((r: any) => r.imdb_id);
        if (releaseWithImdb?.imdb_id) {
          movieGroup.imdbId = releaseWithImdb.imdb_id;
        }
      }
      
      // If we have TMDB ID but no poster, fetch directly from TMDB
      if (movieGroup.tmdbId && !movieGroup.posterUrl && tmdbApiKey) {
        try {
          const tmdbMovie = await tmdbClient.getMovie(movieGroup.tmdbId);
          if (tmdbMovie && tmdbMovie.poster_path) {
            const posterUrl = tmdbClient.getPosterUrl(tmdbMovie.poster_path);
            movieGroup.posterUrl = posterUrl ?? undefined;
            console.log(`  Fetched poster from TMDB for movie ID ${movieGroup.tmdbId}`);
          }
          // Also update IMDB ID and language if missing
          if (!movieGroup.imdbId && tmdbMovie?.imdb_id) {
            movieGroup.imdbId = tmdbMovie.imdb_id;
          }
          if (!movieGroup.originalLanguage && tmdbMovie?.original_language) {
            movieGroup.originalLanguage = tmdbMovie.original_language;
          }
        } catch (error) {
          console.error(`Error fetching TMDB movie ${movieGroup.tmdbId} for poster:`, error);
        }
      }
      
      // If we still don't have TMDB ID or poster, try TMDB API search
      if ((!movieGroup.tmdbId || !movieGroup.posterUrl) && tmdbApiKey) {
        try {
          // Get a release to extract title and year for search
          const searchRelease = movieGroup.add[0] || movieGroup.existing[0] || movieGroup.upgrade[0];
          if (searchRelease) {
            const searchTitle = searchRelease.tmdb_title || 
                              searchRelease.radarr_movie_title || 
                              searchRelease.title.split(/\s+\d{4}/)[0];
            const searchYear = searchRelease.year;
            
            const tmdbMovie = await tmdbClient.searchMovie(searchTitle, searchYear);
            if (tmdbMovie) {
              if (!movieGroup.tmdbId) {
                movieGroup.tmdbId = tmdbMovie.id;
              }
              if (!movieGroup.posterUrl && tmdbMovie.poster_path) {
                const posterUrl = tmdbClient.getPosterUrl(tmdbMovie.poster_path);
                movieGroup.posterUrl = posterUrl ?? undefined;
              }
              if (!movieGroup.imdbId && tmdbMovie.imdb_id) {
                movieGroup.imdbId = tmdbMovie.imdb_id;
              }
              if (!movieGroup.originalLanguage && tmdbMovie.original_language) {
                movieGroup.originalLanguage = tmdbMovie.original_language;
              }
            }
          }
        } catch (error) {
          console.error(`Error searching TMDB for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      // Add poster/metadata to all releases in this group
      const hasRadarrMatch = movieGroup.existing.some(r => r.radarr_movie_id) || movieGroup.upgrade.some(r => r.radarr_movie_id);

      for (const release of [...movieGroup.add, ...movieGroup.existing, ...movieGroup.upgrade]) {
        if (movieGroup.posterUrl) {
          (release as any).posterUrl = movieGroup.posterUrl;
        }
        if (movieGroup.imdbId) {
          (release as any).imdbId = movieGroup.imdbId;
        }
        if (movieGroup.tmdbId) {
          (release as any).tmdbId = movieGroup.tmdbId;
        }
        if (movieGroup.originalLanguage) {
          (release as any).originalLanguage = movieGroup.originalLanguage;
        }
        if (!release.radarr_movie_id && hasRadarrMatch) {
          (release as any).radarrInferred = true;
        }
      }
    }

    // Helper function to get the latest release date from a movie group
    const getLatestDate = (group: typeof movieGroups[0]) => {
      const allReleases = [...group.add, ...group.existing, ...group.upgrade];
      if (allReleases.length === 0) return 0;
      const dates = allReleases.map(r => new Date(r.published_at).getTime());
      return Math.max(...dates);
    };

    // Helper function to categorize a date into time periods (simplified: today, yesterday, older)
    const categorizeByTimePeriod = (dateMs: number): string => {
      const now = Date.now();
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (dateMs >= today.getTime()) {
        return 'today';
      } else if (dateMs >= yesterday.getTime()) {
        return 'yesterday';
      } else {
        return 'older';
      }
    };

    // Helper function to get status priority for sorting (lower number = higher priority)
    const getStatusPriority = (group: typeof movieGroups[0]): number => {
      if (group.add.length > 0) return 1; // NEW first
      if (group.upgrade.length > 0) return 2; // UPGRADE second
      return 3; // EXISTING/IGNORED last
    };

    // Filter out movie groups that have no releases to display (but include ignored)
    const filteredMovieGroups = movieGroups.filter(group => 
      group.add.length > 0 || 
      group.existing.length > 0 || 
      group.upgrade.length > 0 || 
      group.ignored.length > 0
    );

    // Separate into New Movies, Existing Movies, Unmatched Items, and Ignored Items
    const newMovies: typeof movieGroups = [];
    const existingMovies: typeof movieGroups = [];
    const unmatchedItems: typeof movieGroups = [];
    const ignoredItems: typeof movieGroups = [];

    for (const group of filteredMovieGroups) {
      // Check if this is an unmatched item (no TMDB ID and no Radarr ID)
      if (!group.tmdbId && !group.radarrMovieId) {
        unmatchedItems.push(group);
      } else if (group.add.length > 0 || group.upgrade.length > 0) {
        // Has new releases or upgrades - goes to "New Movies"
        newMovies.push(group);
      } else if (group.existing.length > 0) {
        // Only existing releases - goes to "Existing Movies"
        existingMovies.push(group);
      } else if (group.ignored.length > 0) {
        // Only ignored releases - goes to "Ignored Items"
        ignoredItems.push(group);
      }
    }

    // Helper function to group by time period
    const groupByTimePeriod = (groups: typeof movieGroups) => {
      const grouped: { [key: string]: typeof movieGroups } = {
        today: [],
        yesterday: [],
        older: [],
      };

      for (const group of groups) {
        const latestDate = getLatestDate(group);
        const period = categorizeByTimePeriod(latestDate);
        
        // Map to simplified periods: today, yesterday, older
        if (period === 'today') {
          grouped.today.push(group);
        } else if (period === 'yesterday') {
          grouped.yesterday.push(group);
        } else {
          grouped.older.push(group);
        }
      }

      // Sort within each time period: first by status priority, then by date (newest first)
      for (const period in grouped) {
        grouped[period].sort((a, b) => {
          const priorityA = getStatusPriority(a);
          const priorityB = getStatusPriority(b);
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          const dateA = getLatestDate(a);
          const dateB = getLatestDate(b);
          return dateB - dateA;
        });
      }

      return grouped;
    };

    const newMoviesByPeriod = groupByTimePeriod(newMovies);
    const existingMoviesByPeriod = groupByTimePeriod(existingMovies);
    // Unmatched and Ignored items don't need time period grouping

    // Get Radarr base URL for links
    const radarrBaseUrl = config.radarr.apiUrl.replace('/api/v3', '');

    res.render('dashboard', {
      newMoviesByPeriod,
      existingMoviesByPeriod,
      unmatchedItems,
      ignoredItems,
      radarrBaseUrl,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

// Refresh dashboard (runs matching engine)
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    // Check if matching is already running
    const current = syncProgress.get();
    if (current && current.isRunning && current.type === 'matching') {
      return res.json({ success: false, message: 'Dashboard refresh is already in progress' });
    }

    // Start matching engine in background
    (async () => {
      try {
        console.log('Starting dashboard refresh (matching engine) from API endpoint...');
        syncProgress.start('matching', 0);
        syncProgress.update('Starting matching engine...', 0);
        
        const stats = await runMatchingEngine();
        
        syncProgress.update('Matching completed', stats.processed, stats.processed, stats.errors);
        syncProgress.complete();
        
        console.log('Dashboard refresh completed successfully');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Dashboard refresh error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Dashboard refresh started' });
  } catch (error: any) {
    console.error('Start dashboard refresh error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start dashboard refresh',
      message: error?.message || 'Unknown error'
    });
  }
});

// Get refresh progress
router.get('/refresh/progress', (req: Request, res: Response) => {
  const progress = syncProgress.get();
  res.json(progress || { isRunning: false });
});

export default router;

