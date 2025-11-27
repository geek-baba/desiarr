import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { tvReleasesModel } from '../models/tvReleases';
import { feedsModel } from '../models/feeds';
import { settingsModel } from '../models/settings';
import { config } from '../config';
import { Release } from '../types/Release';
import { getSyncedRadarrMovieByTmdbId, getSyncedRadarrMovieByRadarrId, syncRadarrMovies } from '../services/radarrSync';
import { syncSonarrShows } from '../services/sonarrSync';
import { syncRssFeeds } from '../services/rssSync';
import { runMatchingEngine } from '../services/matchingEngine';
import { runTvMatchingEngine } from '../services/tvMatchingEngine';
import { syncProgress } from '../services/syncProgress';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import { buildShowKey, ignoredShowsModel } from '../models/ignoredShows';
import db from '../db';

const router = Router();

function sanitizeTitle(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate TVDB URL from TVDB ID, slug, and show name
 * TVDB v4 uses slug-based URLs: https://thetvdb.com/series/{slug}
 * Prefers API-provided slug, falls back to generated slug, then numeric ID
 */
function getTvdbUrl(tvdbId: number | undefined, tvdbSlug?: string | null, showName?: string): string {
  if (!tvdbId) {
    return '#';
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

// Root dashboard route - redirect to movies or show selector
router.get('/', async (req: Request, res: Response) => {
  // Default to combined dashboard view
  res.redirect('/dashboard');
});

// Combined Dashboard route (movies + TV shows)
// This route processes both movies and TV shows and combines them into a unified view
// NOTE: This duplicates processing logic from /movies and /tv routes.
// In a production version, this should be extracted into reusable helper functions.
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    // Get base URLs and settings first
    const allSettings = settingsModel.getAll();
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value || '';
    let radarrBaseUrl = '';
    if (radarrApiUrl) {
      radarrBaseUrl = radarrApiUrl.replace(/\/api\/v3\/?$/i, '').replace(/\/$/, '');
    }
    
    const sonarrApiUrl = allSettings.find(s => s.key === 'sonarr_api_url')?.value || '';
    let sonarrBaseUrl = '';
    if (sonarrApiUrl) {
      sonarrBaseUrl = sonarrApiUrl.replace(/\/api\/v3\/?$/i, '').replace(/\/$/, '');
    }

    const lastRefreshResult = db.prepare("SELECT value FROM app_settings WHERE key = 'matching_last_run'").get() as { value: string } | undefined;
    const lastRefresh = lastRefreshResult?.value ? new Date(lastRefreshResult.value) : null;
    const appSettings = settingsModel.getAppSettings();

    // ========== PROCESS MOVIES (same logic as /movies route) ==========
    const allMovieReleases = db.prepare(`
      SELECT r.* FROM movie_releases r
      INNER JOIN rss_feed_items rss ON r.guid = rss.guid
      INNER JOIN rss_feeds f ON rss.feed_id = f.id
      WHERE f.feed_type = 'movie'
      ORDER BY r.published_at DESC
    `).all() as any[];
    const movieFeeds = feedsModel.getAll().filter(f => f.feed_type === 'movie');
    
    const movieFeedMap: { [key: number]: string } = {};
    for (const feed of movieFeeds) {
      if (feed.id) {
        movieFeedMap[feed.id] = feed.name;
      }
    }

    for (const release of allMovieReleases) {
      (release as any).feedName = movieFeedMap[release.feed_id] || 'Unknown Feed';
    }

    // Group movies (same logic as /movies)
    const releasesByMovie: { [key: string]: any[] } = {};
    const idToKeyMap: { [key: string]: string } = {};
    
    for (const release of allMovieReleases) {
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
    
    for (const release of allMovieReleases) {
      if (!release.tmdb_id && !release.radarr_movie_id) {
        const releaseMovieKey = extractMovieNameAndYear(release.normalized_title, release.year);
        const titleKey = `title_${releaseMovieKey}`;
        
        let matched = false;
        for (const existingKey in releasesByMovie) {
          const existingReleases = releasesByMovie[existingKey];
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
        
        if (!matched) {
          if (!releasesByMovie[titleKey]) {
            releasesByMovie[titleKey] = [];
          }
          releasesByMovie[titleKey].push(release);
        }
      }
    }

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
      const primaryRelease = releases.find(r => r.radarr_movie_id) || 
                            releases.find(r => r.tmdb_id) || 
                            releases[0];
      
      if (primaryRelease.tmdb_id && !primaryRelease.tmdb_title) {
        const syncedMovie = getSyncedRadarrMovieByTmdbId(primaryRelease.tmdb_id);
        if (syncedMovie && syncedMovie.title) {
          primaryRelease.tmdb_title = syncedMovie.title;
        }
      }
      
      if (primaryRelease.radarr_movie_id && !primaryRelease.radarr_movie_title) {
        const syncedMovie = getSyncedRadarrMovieByRadarrId(primaryRelease.radarr_movie_id);
        if (syncedMovie && syncedMovie.title) {
          primaryRelease.radarr_movie_title = syncedMovie.title;
        }
      }
      
      if (primaryRelease.tmdb_title || primaryRelease.radarr_movie_title) {
        const properTitle = primaryRelease.radarr_movie_title || primaryRelease.tmdb_title;
        for (const release of releases) {
          if (!release.tmdb_title && !release.radarr_movie_title) {
            if (primaryRelease.radarr_movie_title) {
              release.radarr_movie_title = primaryRelease.radarr_movie_title;
            } else if (primaryRelease.tmdb_title) {
              release.tmdb_title = primaryRelease.tmdb_title;
            }
          }
        }
      }
      
      const movieTitle = buildDisplayTitle(primaryRelease);

      let hasRadarrMatch = releases.some(r => Boolean(r.radarr_movie_id));
      let radarrMovieId: number | undefined = primaryRelease.radarr_movie_id;
      
      if (!hasRadarrMatch && primaryRelease.tmdb_id) {
        const syncedMovie = getSyncedRadarrMovieByTmdbId(primaryRelease.tmdb_id);
        if (syncedMovie) {
          hasRadarrMatch = true;
          radarrMovieId = syncedMovie.radarr_id;
          for (const release of releases) {
            if (!release.radarr_movie_id) {
              release.radarr_movie_id = syncedMovie.radarr_id;
            }
          }
          primaryRelease.radarr_movie_id = syncedMovie.radarr_id;
        }
      }
      
      const upgrade = releases.filter(r => (
        r.radarr_movie_id &&
        (r.status === 'UPGRADE_CANDIDATE' || r.status === 'UPGRADED')
      ));
      const upgradeGuids = new Set(upgrade.map(r => r.guid));

      const add = hasRadarrMatch
        ? []
        : releases.filter(r => !r.radarr_movie_id && (r.status === 'NEW' || r.status === 'ATTENTION_NEEDED'));

      const existing = releases.filter(r => (
        r.radarr_movie_id &&
        !upgradeGuids.has(r.guid)
      ));
      
      const ignored = releases.filter(r => r.status === 'IGNORED' && !r.radarr_movie_id);
      
      let radarrInfo: any = null;
      if (primaryRelease.radarr_movie_id) {
        const syncedRadarrMovie = getSyncedRadarrMovieByRadarrId(primaryRelease.radarr_movie_id);
        if (syncedRadarrMovie) {
          try {
            if (syncedRadarrMovie.movie_file) {
              const movieFile = JSON.parse(syncedRadarrMovie.movie_file);
              radarrInfo = {
                path: syncedRadarrMovie.path,
                fileName: movieFile.relativePath ? movieFile.relativePath.split('/').pop() : null,
                resolution: movieFile.quality?.quality?.resolution || null,
                codec: null,
                sourceTag: movieFile.quality?.quality?.source || null,
                audio: null,
                sizeMb: movieFile.size ? movieFile.size / (1024 * 1024) : null,
                mediaInfo: movieFile.mediaInfo || null,
              };
              
              if (movieFile.relativePath) {
                const parsed = parseReleaseFromTitle(movieFile.relativePath);
                radarrInfo.codec = parsed.codec;
                radarrInfo.resolution = parsed.resolution || radarrInfo.resolution;
                radarrInfo.sourceTag = parsed.sourceTag || radarrInfo.sourceTag;
                radarrInfo.audio = parsed.audio;
              }
            }
            
            if (radarrInfo) {
              const releaseWithHistory = releases.find(r => r.radarr_history);
              if (releaseWithHistory && releaseWithHistory.radarr_history) {
                try {
                  const history = JSON.parse(releaseWithHistory.radarr_history);
                  if (Array.isArray(history) && history.length > 0) {
                    const downloadEvents = history.filter((h: any) => 
                      h.eventType === 'downloadFolderImported' || 
                      h.eventType === 'grabbed' ||
                      h.eventType === 'downloadCompleted'
                    );
                    if (downloadEvents.length > 0) {
                      downloadEvents.sort((a: any, b: any) => 
                        new Date(b.date).getTime() - new Date(a.date).getTime()
                      );
                      const lastDownload = downloadEvents[0];
                      radarrInfo.lastDownload = {
                        sourceTitle: lastDownload.sourceTitle || null,
                        date: lastDownload.date || null,
                        releaseGroup: lastDownload.data?.releaseGroup || null,
                      };
                      
                      if (lastDownload.sourceTitle && (!radarrInfo.resolution || radarrInfo.resolution === 'UNKNOWN' || 
                          !radarrInfo.codec || radarrInfo.codec === 'UNKNOWN' || 
                          !radarrInfo.sourceTag || radarrInfo.sourceTag === 'OTHER' ||
                          !radarrInfo.audio || radarrInfo.audio === 'Unknown')) {
                        try {
                          const parsed = parseReleaseFromTitle(lastDownload.sourceTitle);
                          if (!radarrInfo.resolution || radarrInfo.resolution === 'UNKNOWN') {
                            radarrInfo.resolution = parsed.resolution;
                          }
                          if (!radarrInfo.codec || radarrInfo.codec === 'UNKNOWN') {
                            radarrInfo.codec = parsed.codec;
                          }
                          if (!radarrInfo.sourceTag || radarrInfo.sourceTag === 'OTHER') {
                            radarrInfo.sourceTag = parsed.sourceTag;
                          }
                          if (!radarrInfo.audio || radarrInfo.audio === 'Unknown') {
                            radarrInfo.audio = parsed.audio;
                          }
                          if (!radarrInfo.sizeMb && parsed.sizeMb) {
                            radarrInfo.sizeMb = parsed.sizeMb;
                          }
                        } catch (e) {
                          console.error('Error parsing lastDownload.sourceTitle:', e);
                        }
                      }
                    }
                  }
                } catch (e) {
                  console.error('Error parsing radarr_history:', e);
                }
              }
            }
          } catch (e) {
            console.error('Error parsing Radarr movie file:', e);
          }
        }
      }
      
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
      
      const imdbIdFromRelease = releases.find(r => r.imdb_id)?.imdb_id;
      let finalRadarrMovieId = radarrMovieId || primaryRelease.radarr_movie_id;
      
      if (finalRadarrMovieId) {
        const syncedMovie = getSyncedRadarrMovieByRadarrId(finalRadarrMovieId);
        if (syncedMovie) {
          finalRadarrMovieId = syncedMovie.radarr_id;
        }
      }
      
      movieGroups.push({
        movieKey,
        movieTitle,
        tmdbId: primaryRelease.tmdb_id,
        radarrMovieId: finalRadarrMovieId,
        imdbId: imdbIdFromRelease,
        radarrInfo,
        add,
        existing,
        upgrade,
        ignored,
      });
    }

    // Enrich movies with metadata
    for (const movieGroup of movieGroups) {
      const groupReleases = releasesByMovie[movieGroup.movieKey] || [];
      
      const releaseWithPoster = groupReleases.find((r: any) => r.tmdb_poster_url);
      if (releaseWithPoster?.tmdb_poster_url) {
        movieGroup.posterUrl = releaseWithPoster.tmdb_poster_url;
      }
      
      if (!movieGroup.posterUrl && (movieGroup.tmdbId || movieGroup.radarrMovieId)) {
        try {
          let syncedMovie: any = null;
          if (movieGroup.radarrMovieId) {
            syncedMovie = getSyncedRadarrMovieByRadarrId(movieGroup.radarrMovieId);
          } else if (movieGroup.tmdbId) {
            syncedMovie = getSyncedRadarrMovieByTmdbId(movieGroup.tmdbId);
          }
          
          if (syncedMovie) {
            if (syncedMovie.images) {
              try {
                const images = JSON.parse(syncedMovie.images);
                if (Array.isArray(images) && images.length > 0) {
                  const poster = images.find((img: any) => img.coverType === 'poster');
                  if (poster) {
                    movieGroup.posterUrl = poster.remoteUrl || poster.url;
                  }
                }
              } catch (error) {
                console.error('Error parsing synced Radarr images:', error);
              }
            }
            
            if (syncedMovie.imdb_id && !movieGroup.imdbId) {
              movieGroup.imdbId = syncedMovie.imdb_id;
            }
            
            if (syncedMovie.original_language && !movieGroup.originalLanguage) {
              movieGroup.originalLanguage = syncedMovie.original_language;
            }
            
            if (syncedMovie.tmdb_id && !movieGroup.tmdbId) {
              movieGroup.tmdbId = syncedMovie.tmdb_id;
            }
          }
        } catch (error) {
          console.error(`Error getting synced movie metadata for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      if (!movieGroup.imdbId) {
        const releaseWithImdb = groupReleases.find((r: any) => r.imdb_id);
        if (releaseWithImdb?.imdb_id) {
          movieGroup.imdbId = releaseWithImdb.imdb_id;
        }
      }
      
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

    const getLatestDate = (group: typeof movieGroups[0]) => {
      const allReleases = [...group.add, ...group.existing, ...group.upgrade];
      if (allReleases.length === 0) return 0;
      const dates = allReleases.map(r => new Date(r.published_at).getTime());
      return Math.max(...dates);
    };

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

    const getStatusPriority = (group: typeof movieGroups[0]): number => {
      if (group.add.length > 0) return 1;
      if (group.upgrade.length > 0) return 2;
      return 3;
    };

    const filteredMovieGroups = movieGroups.filter(group => 
      group.add.length > 0 || 
      group.existing.length > 0 || 
      group.upgrade.length > 0 || 
      group.ignored.length > 0
    );

    const newMovies: typeof movieGroups = [];
    const existingMovies: typeof movieGroups = [];
    const unmatchedMovies: typeof movieGroups = [];

    for (const group of filteredMovieGroups) {
      const allGroupReleases = [
        ...(group.add || []),
        ...(group.existing || []),
        ...(group.upgrade || []),
        ...(group.ignored || []),
      ];
      const manuallyIgnoredOnly = allGroupReleases.length > 0 && allGroupReleases.every((release: any) => release.manually_ignored);
      if (manuallyIgnoredOnly) {
        continue;
      }

      if (!group.tmdbId && !group.radarrMovieId) {
        unmatchedMovies.push(group);
      } else if (group.radarrMovieId || group.existing.length > 0) {
        existingMovies.push(group);
      } else if (group.add.length > 0 || group.upgrade.length > 0) {
        newMovies.push(group);
      } else if (group.ignored.length > 0 && group.tmdbId) {
        newMovies.push(group);
      }
    }

    const groupByTimePeriod = (groups: typeof movieGroups) => {
      const grouped: { [key: string]: typeof movieGroups } = {
        today: [],
        yesterday: [],
        older: [],
      };

      for (const group of groups) {
        const latestDate = getLatestDate(group);
        const period = categorizeByTimePeriod(latestDate);
        
        if (period === 'today') {
          grouped.today.push(group);
        } else if (period === 'yesterday') {
          grouped.yesterday.push(group);
        } else {
          grouped.older.push(group);
        }
      }

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

    // ========== PROCESS TV SHOWS (same logic as /tv route) ==========
    const allTvReleases = tvReleasesModel.getAll();
    const tvFeeds = feedsModel.getAll();
    
    const tvFeedMap: { [key: number]: string } = {};
    for (const feed of tvFeeds) {
      if (feed.id) {
        tvFeedMap[feed.id] = feed.name;
      }
    }

    for (const release of allTvReleases) {
      (release as any).feedName = tvFeedMap[release.feed_id] || 'Unknown Feed';
    }

    const ignoredShowKeys = ignoredShowsModel.getAllKeys();
    const releasesByShow: { [key: string]: any[] } = {};
    
    for (const release of allTvReleases) {
      const showKey = buildShowKey({
        tvdbId: release.tvdb_id || null,
        tmdbId: release.tmdb_id || null,
        showName: release.show_name || release.title || null,
      });
      
      if (!showKey) {
        continue;
      }
      
      if (!releasesByShow[showKey]) {
        releasesByShow[showKey] = [];
      }
      releasesByShow[showKey].push(release);
    }

    type ShowGroup = {
      showKey: string;
      showName: string;
      tvdbId?: number;
      tvdbUrl?: string;
      tmdbId?: number;
      imdbId?: string;
      sonarrSeriesId?: number;
      sonarrSeriesTitle?: string;
      posterUrl?: string;
      newShows: any[];
      existingShows: any[];
      unmatched: any[];
      manuallyIgnored: boolean;
      ignoreReleaseId?: number | null;
    };
    const showGroups: ShowGroup[] = [];

    for (const showKey in releasesByShow) {
      const releases = releasesByShow[showKey];
      
      const primaryRelease = releases.find(r => r.tvdb_id) || 
                            releases.find(r => r.tmdb_id) || 
                            releases.find(r => r.sonarr_series_id) ||
                            releases[0];
      
      const showName = primaryRelease.sonarr_series_title || 
                      primaryRelease.show_name || 
                      primaryRelease.title || 
                      'Unknown Show';

      const newShows = releases.filter(r => r.status === 'NEW_SHOW' || r.status === 'NEW_SEASON');
      const existingShows = releases.filter(r => r.sonarr_series_id && (r.status === 'IGNORED' || r.status === 'ADDED'));
      const unmatched = releases.filter(r => !r.tvdb_id && !r.tmdb_id && !r.sonarr_series_id);

      let posterUrl: string | undefined;
      const releaseWithPoster = releases.find(r => r.tmdb_poster_url || r.tvdb_poster_url);
      if (releaseWithPoster) {
        posterUrl = releaseWithPoster.tmdb_poster_url || releaseWithPoster.tvdb_poster_url;
      }

      const allShowReleases = [...newShows, ...existingShows, ...unmatched];
      const isIgnoredInList = ignoredShowKeys.has(showKey);
      const manuallyIgnored = isIgnoredInList || (allShowReleases.length > 0 && allShowReleases.every((release: any) => release.manually_ignored));
      const ignoreReleaseId = allShowReleases[0]?.id || null;

      const tvdbId = primaryRelease.tvdb_id;
      const tvdbSlug = primaryRelease.tvdb_slug;
      const tvdbUrl = getTvdbUrl(tvdbId, tvdbSlug, showName);

      showGroups.push({
        showKey,
        showName,
        tvdbId,
        tvdbUrl,
        tmdbId: primaryRelease.tmdb_id,
        imdbId: primaryRelease.imdb_id,
        sonarrSeriesId: primaryRelease.sonarr_series_id,
        sonarrSeriesTitle: primaryRelease.sonarr_series_title,
        posterUrl,
        newShows,
        existingShows,
        unmatched,
        manuallyIgnored,
        ignoreReleaseId,
      });
    }

    const getLatestDateTv = (group: ShowGroup) => {
      const allReleases = [...group.newShows, ...group.existingShows, ...group.unmatched];
      if (allReleases.length === 0) return 0;
      const dates = allReleases.map(r => new Date(r.published_at).getTime());
      return Math.max(...dates);
    };

    const categorizeByTimePeriodTv = (dateMs: number): string => {
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

    const getStatusPriorityTv = (group: ShowGroup): number => {
      if (group.newShows.length > 0) return 1;
      if (group.existingShows.length > 0) return 2;
      return 3;
    };

    const filteredShowGroups = showGroups.filter(group => 
      !group.manuallyIgnored &&
      (group.newShows.length > 0 || 
      group.existingShows.length > 0 || 
      group.unmatched.length > 0)
    );

    const newTvShows: typeof showGroups = [];
    const existingTvShows: typeof showGroups = [];
    const unmatchedTvShows: typeof showGroups = [];

    for (const group of filteredShowGroups) {
      if (!group.tvdbId && !group.tmdbId && !group.sonarrSeriesId) {
        unmatchedTvShows.push(group);
      } else if (group.sonarrSeriesId || group.existingShows.length > 0) {
        existingTvShows.push(group);
      } else if (group.newShows.length > 0) {
        newTvShows.push(group);
      }
    }

    const groupByTimePeriodTv = (groups: typeof showGroups) => {
      const grouped: { [key: string]: typeof showGroups } = {
        today: [],
        yesterday: [],
        older: [],
      };

      for (const group of groups) {
        const latestDate = getLatestDateTv(group);
        const period = categorizeByTimePeriodTv(latestDate);
        
        if (period === 'today') {
          grouped.today.push(group);
        } else if (period === 'yesterday') {
          grouped.yesterday.push(group);
        } else {
          grouped.older.push(group);
        }
      }

      for (const period in grouped) {
        grouped[period].sort((a, b) => {
          const priorityA = getStatusPriorityTv(a);
          const priorityB = getStatusPriorityTv(b);
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          const dateA = getLatestDateTv(a);
          const dateB = getLatestDateTv(b);
          return dateB - dateA;
        });
      }

      return grouped;
    };

    const newTvShowsByPeriod = groupByTimePeriodTv(newTvShows);
    const existingTvShowsByPeriod = groupByTimePeriodTv(existingTvShows);
    
    // ========== RENDER COMBINED VIEW ==========
    res.render('dashboard', {
      viewType: 'combined',
      // Movies data
      newMoviesByPeriod,
      existingMoviesByPeriod,
      unmatchedItems: unmatchedMovies,
      // TV shows data
      newTvShowsByPeriod,
      existingTvShowsByPeriod,
      unmatchedItemsTv: unmatchedTvShows,
      // Common data
      radarrBaseUrl,
      sonarrBaseUrl,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      appSettings,
    });
  } catch (error) {
    console.error('Combined Dashboard error:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// Movies Dashboard route
router.get('/movies', async (req: Request, res: Response) => {
  try {
    // Get all releases from movie feeds only (dashboard now uses only synced data, no real-time API calls)
    // Filter to only include releases from feeds with feed_type = 'movie'
    const allReleases = db.prepare(`
      SELECT r.* FROM movie_releases r
      INNER JOIN rss_feed_items rss ON r.guid = rss.guid
      INNER JOIN rss_feeds f ON rss.feed_id = f.id
      WHERE f.feed_type = 'movie'
      ORDER BY r.published_at DESC
    `).all() as any[];
    const feeds = feedsModel.getAll().filter(f => f.feed_type === 'movie');
    
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
      
      // Ensure we have the proper title from synced Radarr data if we have IDs
      // This ensures we use the actual movie title instead of the release filename
      if (primaryRelease.tmdb_id && !primaryRelease.tmdb_title) {
        // Get title from synced Radarr data
        const syncedMovie = getSyncedRadarrMovieByTmdbId(primaryRelease.tmdb_id);
        if (syncedMovie && syncedMovie.title) {
          primaryRelease.tmdb_title = syncedMovie.title;
        }
      }
      
      if (primaryRelease.radarr_movie_id && !primaryRelease.radarr_movie_title) {
        // Try to get title from synced Radarr data
        const syncedMovie = getSyncedRadarrMovieByRadarrId(primaryRelease.radarr_movie_id);
        if (syncedMovie && syncedMovie.title) {
          primaryRelease.radarr_movie_title = syncedMovie.title;
        }
      }
      
      // Also update all releases in the group with the proper title if we found it
      if (primaryRelease.tmdb_title || primaryRelease.radarr_movie_title) {
        const properTitle = primaryRelease.radarr_movie_title || primaryRelease.tmdb_title;
        for (const release of releases) {
          if (!release.tmdb_title && !release.radarr_movie_title) {
            if (primaryRelease.radarr_movie_title) {
              release.radarr_movie_title = primaryRelease.radarr_movie_title;
            } else if (primaryRelease.tmdb_title) {
              release.tmdb_title = primaryRelease.tmdb_title;
            }
          }
        }
      }
      
      const movieTitle = buildDisplayTitle(primaryRelease);

      // Check if movie is in Radarr by checking synced Radarr data (even if releases don't have radarr_movie_id set)
      // IMPORTANT: Do this BEFORE categorizing releases to ensure proper categorization
      let hasRadarrMatch = releases.some(r => Boolean(r.radarr_movie_id));
      let radarrMovieId: number | undefined = primaryRelease.radarr_movie_id;
      
      if (!hasRadarrMatch && primaryRelease.tmdb_id) {
        const syncedMovie = getSyncedRadarrMovieByTmdbId(primaryRelease.tmdb_id);
        if (syncedMovie) {
          hasRadarrMatch = true;
          radarrMovieId = syncedMovie.radarr_id;
          // Update ALL releases in this group with radarr_movie_id BEFORE categorization
          for (const release of releases) {
            if (!release.radarr_movie_id) {
              release.radarr_movie_id = syncedMovie.radarr_id;
            }
          }
          // Also update primary release
          primaryRelease.radarr_movie_id = syncedMovie.radarr_id;
        }
      }
      
      // Categorize releases by state (now that all releases have radarr_movie_id if movie is in Radarr)
      const upgrade = releases.filter(r => (
        r.radarr_movie_id &&
        (r.status === 'UPGRADE_CANDIDATE' || r.status === 'UPGRADED')
      ));
      const upgradeGuids = new Set(upgrade.map(r => r.guid));

      // Add releases: those without radarr_movie_id (includes NEW and ATTENTION_NEEDED)
      // If movie is in Radarr, no releases should be in "add"
      const add = hasRadarrMatch
        ? []
        : releases.filter(r => !r.radarr_movie_id && (r.status === 'NEW' || r.status === 'ATTENTION_NEEDED'));

      // Existing releases: those with radarr_movie_id but not upgrade candidates
      // This includes IGNORED releases if they have radarr_movie_id (they represent existing movies)
      const existing = releases.filter(r => (
        r.radarr_movie_id && // Must have radarr_movie_id
        !upgradeGuids.has(r.guid) // Not an upgrade candidate
      ));
      
      // Ignored releases: those with IGNORED status AND no radarr_movie_id
      // (releases with radarr_movie_id and IGNORED status are already in "existing")
      const ignored = releases.filter(r => r.status === 'IGNORED' && !r.radarr_movie_id);
      
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
            // Only if radarrInfo was successfully created
            if (radarrInfo) {
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
                      
                      // Parse lastDownload.sourceTitle to extract metadata if missing
                      if (lastDownload.sourceTitle && (!radarrInfo.resolution || radarrInfo.resolution === 'UNKNOWN' || 
                          !radarrInfo.codec || radarrInfo.codec === 'UNKNOWN' || 
                          !radarrInfo.sourceTag || radarrInfo.sourceTag === 'OTHER' ||
                          !radarrInfo.audio || radarrInfo.audio === 'Unknown')) {
                        try {
                          const parsed = parseReleaseFromTitle(lastDownload.sourceTitle);
                          // Only use parsed values if current values are missing/unknown
                          if (!radarrInfo.resolution || radarrInfo.resolution === 'UNKNOWN') {
                            radarrInfo.resolution = parsed.resolution;
                          }
                          if (!radarrInfo.codec || radarrInfo.codec === 'UNKNOWN') {
                            radarrInfo.codec = parsed.codec;
                          }
                          if (!radarrInfo.sourceTag || radarrInfo.sourceTag === 'OTHER') {
                            radarrInfo.sourceTag = parsed.sourceTag;
                          }
                          if (!radarrInfo.audio || radarrInfo.audio === 'Unknown') {
                            radarrInfo.audio = parsed.audio;
                          }
                          if (!radarrInfo.sizeMb && parsed.sizeMb) {
                            radarrInfo.sizeMb = parsed.sizeMb;
                          }
                        } catch (e) {
                          console.error('Error parsing lastDownload.sourceTitle:', e);
                        }
                      }
                    }
                  }
                } catch (e) {
                  console.error('Error parsing radarr_history:', e);
                }
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
      
      // Ensure we use the correct Radarr movie ID (from radarr_movies table if available)
      let finalRadarrMovieId = radarrMovieId || primaryRelease.radarr_movie_id;
      
      // If we have a radarr_movie_id, verify it exists in radarr_movies table to get the correct ID
      if (finalRadarrMovieId) {
        const syncedMovie = getSyncedRadarrMovieByRadarrId(finalRadarrMovieId);
        if (syncedMovie) {
          // Use the radarr_id from the synced table (this is the actual Radarr movie ID)
          finalRadarrMovieId = syncedMovie.radarr_id;
        }
      }
      
      movieGroups.push({
        movieKey,
        movieTitle,
        tmdbId: primaryRelease.tmdb_id,
        radarrMovieId: finalRadarrMovieId, // Use the verified Radarr movie ID
        imdbId: imdbIdFromRelease, // Add IMDB ID from releases
        radarrInfo, // Add Radarr info to the movie group
        add,
        existing,
        upgrade,
        ignored, // Add ignored releases (only those not in Radarr)
      });
    }

    // Enrich with movie metadata (poster, IMDB, etc.)
    // Note: Radarr detection is already done during categorization, so we don't need to do it again here
    for (const movieGroup of movieGroups) {
      // Get all releases for this movie group
      const groupReleases = releasesByMovie[movieGroup.movieKey] || [];
      
      // Get movie metadata from synced Radarr data (no real-time API calls)
      // First, check if any release in the group has a stored TMDB poster URL
      const releaseWithPoster = groupReleases.find((r: any) => r.tmdb_poster_url);
      if (releaseWithPoster?.tmdb_poster_url) {
        movieGroup.posterUrl = releaseWithPoster.tmdb_poster_url;
      }
      
      // If no poster from releases, try synced Radarr data
      if (!movieGroup.posterUrl && (movieGroup.tmdbId || movieGroup.radarrMovieId)) {
        try {
          let syncedMovie: any = null;
          if (movieGroup.radarrMovieId) {
            syncedMovie = getSyncedRadarrMovieByRadarrId(movieGroup.radarrMovieId);
          } else if (movieGroup.tmdbId) {
            syncedMovie = getSyncedRadarrMovieByTmdbId(movieGroup.tmdbId);
          }
          
          if (syncedMovie) {
            // Get poster URL from synced Radarr images (stored as JSON)
            if (syncedMovie.images) {
              try {
                const images = JSON.parse(syncedMovie.images);
                if (Array.isArray(images) && images.length > 0) {
                  const poster = images.find((img: any) => img.coverType === 'poster');
                  if (poster) {
                    movieGroup.posterUrl = poster.remoteUrl || poster.url;
                  }
                }
              } catch (error) {
                console.error('Error parsing synced Radarr images:', error);
              }
            }
            
            // Get IMDB ID from synced data
            if (syncedMovie.imdb_id && !movieGroup.imdbId) {
              movieGroup.imdbId = syncedMovie.imdb_id;
            }
            
            // Get original language from synced data
            if (syncedMovie.original_language && !movieGroup.originalLanguage) {
              movieGroup.originalLanguage = syncedMovie.original_language;
            }
            
            // Ensure TMDB ID is set
            if (syncedMovie.tmdb_id && !movieGroup.tmdbId) {
              movieGroup.tmdbId = syncedMovie.tmdb_id;
            }
          }
        } catch (error) {
          // Silently fail - just don't add metadata
          console.error(`Error getting synced movie metadata for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      // If we still don't have IMDB ID, check releases directly
      if (!movieGroup.imdbId) {
        const releaseWithImdb = groupReleases.find((r: any) => r.imdb_id);
        if (releaseWithImdb?.imdb_id) {
          movieGroup.imdbId = releaseWithImdb.imdb_id;
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

    // Separate into New Movies, Existing Movies, and Unmatched Items
    const newMovies: typeof movieGroups = [];
    const existingMovies: typeof movieGroups = [];
    const unmatchedItems: typeof movieGroups = [];

    for (const group of filteredMovieGroups) {
      const allGroupReleases = [
        ...(group.add || []),
        ...(group.existing || []),
        ...(group.upgrade || []),
        ...(group.ignored || []),
      ];
      const manuallyIgnoredOnly = allGroupReleases.length > 0 && allGroupReleases.every((release: any) => release.manually_ignored);
      if (manuallyIgnoredOnly) {
        continue;
      }

      // Check if this is an unmatched item (no TMDB ID and no Radarr ID)
      if (!group.tmdbId && !group.radarrMovieId) {
        // All unmatched items go to "Unmatched Items" (including ignored ones)
        unmatchedItems.push(group);
      } else if (group.radarrMovieId || group.existing.length > 0) {
        // Movie is in Radarr or has existing releases - goes to "Existing Movies"
        // (ignored releases are included but don't create separate entries)
        existingMovies.push(group);
      } else if (group.add.length > 0 || group.upgrade.length > 0) {
        // Has new releases or upgrades - goes to "New Movies" (even if some releases are ignored)
        newMovies.push(group);
      } else if (group.ignored.length > 0 && group.tmdbId) {
        // Matched movie (has TMDB ID) but only ignored releases - still show in "New Movies"
        // This handles the case where a movie is matched but all releases are ignored (e.g., all 2160p)
        newMovies.push(group);
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

    // Get Radarr base URL for links from settings (not config/env)
    const allSettings = settingsModel.getAll();
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value || '';
    
    // Remove /api/v3 suffix if present to get base URL
    // Also handle trailing slashes
    let radarrBaseUrl = '';
    if (radarrApiUrl) {
      // Remove /api/v3 or /api/v3/ from the end (case insensitive)
      radarrBaseUrl = radarrApiUrl
        .replace(/\/api\/v3\/?$/i, '')  // Remove /api/v3 or /api/v3/
        .replace(/\/$/, '');              // Remove trailing slash
      
      console.log(`[Dashboard] Radarr API URL from settings: ${radarrApiUrl}`);
      console.log(`[Dashboard] Radarr base URL for links: ${radarrBaseUrl}`);
      
      // Validate the URL
      if (!radarrBaseUrl) {
        console.error('[Dashboard] ERROR: Radarr base URL is empty after processing!');
      } else {
        // Test URL format
        try {
          const testUrl = new URL(radarrBaseUrl);
          console.log(`[Dashboard] Radarr base URL validated: ${testUrl.protocol}//${testUrl.host}`);
        } catch (e) {
          console.error(`[Dashboard] ERROR: Invalid Radarr base URL format: ${radarrBaseUrl}`);
        }
      }
    } else {
      console.warn('[Dashboard] No Radarr API URL found in settings');
    }

    // Get last refresh time (matching engine last run)
    const lastRefreshResult = db.prepare("SELECT value FROM app_settings WHERE key = 'matching_last_run'").get() as { value: string } | undefined;
    const lastRefresh = lastRefreshResult?.value ? new Date(lastRefreshResult.value) : null;
    const appSettings = settingsModel.getAppSettings();
    
    res.render('dashboard', {
      viewType: 'movies',
      newMoviesByPeriod,
      existingMoviesByPeriod,
      unmatchedItems,
      radarrBaseUrl,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      appSettings,
    });
  } catch (error) {
    console.error('Movies Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

// TV Dashboard route
router.get('/tv', async (req: Request, res: Response) => {
  try {
    // Get all TV releases
    const allTvReleases = tvReleasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Get feed names for display
    const feedMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
      }
    }

    // Add feed names to releases
    for (const release of allTvReleases) {
      (release as any).feedName = feedMap[release.feed_id] || 'Unknown Feed';
    }

    // Group TV releases by show (using TVDB ID as primary key, fallback to show name)
    // Use the same showKey format as ignored_shows table for consistency
    const ignoredShowKeys = ignoredShowsModel.getAllKeys();
    const releasesByShow: { [key: string]: any[] } = {};
    
    for (const release of allTvReleases) {
      const showKey = buildShowKey({
        tvdbId: release.tvdb_id || null,
        tmdbId: release.tmdb_id || null,
        showName: release.show_name || release.title || null,
      });
      
      if (!showKey) {
        // Skip releases without a valid showKey
        continue;
      }
      
      if (!releasesByShow[showKey]) {
        releasesByShow[showKey] = [];
      }
      releasesByShow[showKey].push(release);
    }

    // Build show groups with metadata
    type ShowGroup = {
      showKey: string;
      showName: string;
      tvdbId?: number;
      tvdbUrl?: string;  // TVDB URL for linking
      tmdbId?: number;
      imdbId?: string;
      sonarrSeriesId?: number;
      sonarrSeriesTitle?: string;
      posterUrl?: string;
      newShows: any[];      // NEW_SHOW or NEW_SEASON status (not in Sonarr)
      existingShows: any[]; // IGNORED or ADDED status (in Sonarr)
      unmatched: any[];     // No IDs, not in Sonarr
      manuallyIgnored: boolean;
      ignoreReleaseId?: number | null;
    };
    const showGroups: ShowGroup[] = [];

    for (const showKey in releasesByShow) {
      const releases = releasesByShow[showKey];
      
      // Get the primary show info (prefer from releases with IDs)
      const primaryRelease = releases.find(r => r.tvdb_id) || 
                            releases.find(r => r.tmdb_id) || 
                            releases.find(r => r.sonarr_series_id) ||
                            releases[0];
      
      const showName = primaryRelease.sonarr_series_title || 
                      primaryRelease.show_name || 
                      primaryRelease.title || 
                      'Unknown Show';

      // Categorize releases by status
      // Similar to Movies: New TVShow (not in Sonarr), Existing TVShow (in Sonarr), Unmatched (no IDs)
      const newShows = releases.filter(r => r.status === 'NEW_SHOW' || r.status === 'NEW_SEASON');
      const existingShows = releases.filter(r => r.sonarr_series_id && (r.status === 'IGNORED' || r.status === 'ADDED'));
      const unmatched = releases.filter(r => !r.tvdb_id && !r.tmdb_id && !r.sonarr_series_id);

      // Get poster URL from any release
      let posterUrl: string | undefined;
      const releaseWithPoster = releases.find(r => r.tmdb_poster_url || r.tvdb_poster_url);
      if (releaseWithPoster) {
        posterUrl = releaseWithPoster.tmdb_poster_url || releaseWithPoster.tvdb_poster_url;
      }

      const allShowReleases = [...newShows, ...existingShows, ...unmatched];
      // Check if show is ignored using the same showKey format
      const isIgnoredInList = ignoredShowKeys.has(showKey);
      const manuallyIgnored = isIgnoredInList || (allShowReleases.length > 0 && allShowReleases.every((release: any) => release.manually_ignored));
      const ignoreReleaseId = allShowReleases[0]?.id || null;

      // Generate TVDB URL using slug format
      // Use stored slug from database if available, otherwise generate from show name
      const tvdbId = primaryRelease.tvdb_id;
      const tvdbSlug = primaryRelease.tvdb_slug;
      const tvdbUrl = getTvdbUrl(tvdbId, tvdbSlug, showName);

      showGroups.push({
        showKey,
        showName,
        tvdbId,
        tvdbUrl,
        tmdbId: primaryRelease.tmdb_id,
        imdbId: primaryRelease.imdb_id,
        sonarrSeriesId: primaryRelease.sonarr_series_id,
        sonarrSeriesTitle: primaryRelease.sonarr_series_title,
        posterUrl,
        newShows,
        existingShows,
        unmatched,
        manuallyIgnored,
        ignoreReleaseId,
      });
    }

    // Helper function to get the latest release date from a show group
    const getLatestDate = (group: ShowGroup) => {
      const allReleases = [...group.newShows, ...group.existingShows, ...group.unmatched];
      if (allReleases.length === 0) return 0;
      const dates = allReleases.map(r => new Date(r.published_at).getTime());
      return Math.max(...dates);
    };

    // Helper function to categorize by time period
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

    // Helper function to get status priority for sorting
    const getStatusPriority = (group: ShowGroup): number => {
      if (group.newShows.length > 0) return 1; // NEW_SHOW first
      if (group.existingShows.length > 0) return 2; // EXISTING second
      return 3; // UNMATCHED last
    };

    // Filter out show groups that have no releases to display
    const filteredShowGroups = showGroups.filter(group => 
      !group.manuallyIgnored &&
      (group.newShows.length > 0 || 
      group.existingShows.length > 0 || 
      group.unmatched.length > 0)
    );

    // Separate into New TVShows, Existing TVShows, and Unmatched Items (matching Movies structure)
    const newTvShows: typeof showGroups = [];
    const existingTvShows: typeof showGroups = [];
    const unmatchedItems: typeof showGroups = [];

    for (const group of filteredShowGroups) {
      // Check if this is an unmatched item (no TVDB ID and no TMDB ID and no Sonarr ID)
      if (!group.tvdbId && !group.tmdbId && !group.sonarrSeriesId) {
        unmatchedItems.push(group);
      } else if (group.sonarrSeriesId || group.existingShows.length > 0) {
        // Show is in Sonarr or has existing releases - goes to "Existing TVShows"
        existingTvShows.push(group);
      } else if (group.newShows.length > 0) {
        // Has new releases - goes to "New TVShows"
        newTvShows.push(group);
      }
    }

    // Helper function to group by time period
    const groupByTimePeriod = (groups: typeof showGroups) => {
      const grouped: { [key: string]: typeof showGroups } = {
        today: [],
        yesterday: [],
        older: [],
      };

      for (const group of groups) {
        const latestDate = getLatestDate(group);
        const period = categorizeByTimePeriod(latestDate);
        
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

    const newTvShowsByPeriod = groupByTimePeriod(newTvShows);
    const existingTvShowsByPeriod = groupByTimePeriod(existingTvShows);
    // Unmatched items don't need time period grouping

    // Get Sonarr base URL for links from settings
    const allSettings = settingsModel.getAll();
    const sonarrApiUrl = allSettings.find(s => s.key === 'sonarr_api_url')?.value || '';
    
    let sonarrBaseUrl = '';
    if (sonarrApiUrl) {
      sonarrBaseUrl = sonarrApiUrl
        .replace(/\/api\/v3\/?$/i, '')
        .replace(/\/$/, '');
    }

    // Get last refresh time (matching engine last run)
    const lastRefreshResult = db.prepare("SELECT value FROM app_settings WHERE key = 'matching_last_run'").get() as { value: string } | undefined;
    const lastRefresh = lastRefreshResult?.value ? new Date(lastRefreshResult.value) : null;
    const appSettings = settingsModel.getAppSettings();
    
    res.render('dashboard', {
      viewType: 'tv',
      newTvShowsByPeriod,
      existingTvShowsByPeriod,
      unmatchedItems,
      sonarrBaseUrl,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      appSettings,
    });
  } catch (error) {
    console.error('TV Dashboard error:', error);
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

// Build & Match endpoint - runs full sync cycle (RSS sync, Radarr sync, matching engine)
router.post('/build-match', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const current = syncProgress.get();
    if (current && current.isRunning) {
      return res.json({ success: false, message: 'Sync is already in progress' });
    }

    // Start full sync cycle in background
    (async () => {
      try {
        console.log('=== Starting Build & Match (full sync cycle) ===');
        syncProgress.start('full', 0);
        
        // Step 1: Sync RSS feeds
        console.log('Step 1: Syncing RSS feeds...');
        syncProgress.update('Step 1: Syncing RSS feeds...', 0);
        try {
          await syncRssFeeds();
        } catch (error: any) {
          console.error('RSS sync error:', error);
          const errorMsg = error?.message || error?.toString() || 'Unknown error';
          syncProgress.update(`Step 1 failed: ${errorMsg}`, 0, 0, 1);
          throw new Error(`RSS sync failed: ${errorMsg}`);
        }
        
        // Step 2: Sync Radarr
        console.log('Step 2: Syncing Radarr movies...');
        syncProgress.update('Step 2: Syncing Radarr movies...', 0);
        try {
          await syncRadarrMovies();
        } catch (error: any) {
          console.error('Radarr sync error:', error);
          const errorMsg = error?.message || error?.toString() || 'Unknown error';
          syncProgress.update(`Step 2 failed: ${errorMsg}`, 0, 0, 1);
          throw new Error(`Radarr sync failed: ${errorMsg}`);
        }
        
        // Step 3: Sync Sonarr
        console.log('Step 3: Syncing Sonarr shows...');
        syncProgress.update('Step 3: Syncing Sonarr shows...', 0);
        try {
          await syncSonarrShows();
        } catch (error: any) {
          console.error('Sonarr sync error (continuing):', error);
          // Continue even if Sonarr sync fails
        }
        
        // Step 4: Run movie matching engine
        console.log('Step 4: Running movie matching engine...');
        syncProgress.update('Step 4: Running movie matching engine...', 0);
        let stats;
        try {
          stats = await runMatchingEngine();
        } catch (error: any) {
          console.error('Matching engine error:', error);
          const errorMsg = error?.message || error?.toString() || 'Unknown error';
          syncProgress.update(`Step 4 failed: ${errorMsg}`, 0, 0, 1);
          throw new Error(`Matching engine failed: ${errorMsg}`);
        }
        
        // Step 5: Run TV matching engine
        console.log('Step 5: Running TV matching engine...');
        syncProgress.update('Step 5: Running TV matching engine...', 0);
        let tvStats;
        try {
          tvStats = await runTvMatchingEngine();
        } catch (error: any) {
          console.error('TV matching engine error (continuing):', error);
          // Continue even if TV matching fails
        }
        
        const totalProcessed = (stats?.processed || 0) + (tvStats?.processed || 0);
        const totalErrors = (stats?.errors || 0) + (tvStats?.errors || 0);
        syncProgress.update('Build & Match completed successfully', totalProcessed, totalProcessed, totalErrors);
        syncProgress.complete();
        
        console.log('=== Build & Match completed ===');
        
        // Clear progress after 5 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 5000);
      } catch (error: any) {
        console.error('Build & Match error in background task:', error);
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        // Include step information if available
        const currentStep = syncProgress.get()?.currentStep || '';
        const finalMessage = currentStep ? `${currentStep}. ${errorMessage}` : `Error: ${errorMessage}`;
        syncProgress.update(finalMessage, 0, 0, 1);
        syncProgress.complete();
        
        // Keep error visible for 30 seconds
        setTimeout(() => {
          syncProgress.clear();
        }, 30000);
      }
    })();

    res.json({ success: true, message: 'Build & Match started' });
  } catch (error: any) {
    console.error('Start Build & Match error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start Build & Match',
      message: error?.message || 'Unknown error'
    });
  }
});

// Get Build & Match progress
router.get('/build-match/progress', (req: Request, res: Response) => {
  const progress = syncProgress.get();
  res.json(progress || { isRunning: false });
});

export default router;

