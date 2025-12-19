import db from '../db';
import { tvReleasesModel } from '../models/tvReleases';
import { settingsModel } from '../models/settings';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import braveClient from '../brave/client';
import tvdbClient from '../tvdb/client';
import { TvRelease, TvReleaseStatus } from '../types/Release';
import { getSyncedRssItems } from './rssSync';
import { getSyncedSonarrShowByTvdbId, getSyncedSonarrShowBySonarrId, findSonarrShowByName } from './sonarrSync';
import { feedsModel } from '../models/feeds';
import { syncProgress } from './syncProgress';
import { ignoredShowsModel, buildShowKey } from '../models/ignoredShows';
import { calculateTitleSimilarity, getLanguageFromRssItem } from '../utils/titleSimilarity';

export interface TvMatchingStats {
  totalRssItems: number;
  processed: number;
  newShows: number;
  newSeasons: number;
  existing: number;
  ignored: number;
  errors: number;
}

/**
 * Parse TV show title to extract show name, season number, and year
 * Examples:
 *   "Show Name 2001 S01" -> { showName: "Show Name", season: 1, year: 2001 }
 *   "Show Name Season 1" -> { showName: "Show Name", season: 1, year: null }
 *   "Show Name S1E1" -> { showName: "Show Name", season: 1, year: null }
 *   "Amrutham 2001 S01E01" -> { showName: "Amrutham", season: 1, year: 2001 }
 */
export function parseTvTitle(title: string): { showName: string; season: number | null; year: number | null } {
  const normalized = title.trim();
  
  // First, extract year if present (before extracting season)
  // Look for year patterns: (2001), [2001], 2001, or standalone 2001
  let year: number | null = null;
  let titleWithoutYear = normalized;
  
  // Try to find year in parentheses or brackets first
  const yearInParens = normalized.match(/[\(\[](19|20)\d{2}[\)\]]/);
  if (yearInParens) {
    year = parseInt(yearInParens[0].replace(/[\(\)\[\]]/g, ''), 10);
    titleWithoutYear = normalized.replace(/[\(\[](19|20)\d{2}[\)\]]/g, ' ').trim();
  } else {
    // Try to find standalone year (4 digits, typically 19xx or 20xx)
    const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      year = parseInt(yearMatch[0], 10);
      // Remove the year from title, but be careful not to remove season numbers
      // Only remove if it's clearly a year (not part of S01, E01, etc.)
      const yearIndex = normalized.indexOf(yearMatch[0]);
      const beforeYear = normalized.substring(0, yearIndex);
      const afterYear = normalized.substring(yearIndex + 4);
      // Check if year is surrounded by spaces or at start/end (not part of other numbers)
      if (yearIndex === 0 || /\s/.test(normalized[yearIndex - 1])) {
        if (yearIndex + 4 === normalized.length || /\s/.test(normalized[yearIndex + 4])) {
          titleWithoutYear = (beforeYear + ' ' + afterYear).trim();
        }
      }
    }
  }
  
  // Normalize dots to spaces for better matching (common in release names)
  const normalizedForParsing = titleWithoutYear.replace(/\./g, ' ');
  
  // Try to match patterns like "Show Name S01", "Show Name Season 1", "Show Name S1E1"
  // Also handles dot-separated formats like "The.Family.Man.S03"
  const seasonPatterns = [
    /^(.+?)[\s\.]+S(\d+)(?:E\d+)?/i, // "Show Name S01" or "Show.Name.S03" or "Show Name S1E1"
    /^(.+?)[\s\.]+Season[\s\.]+(\d+)/i, // "Show Name Season 1" or "Show.Name.Season.1"
    /^(.+?)[\s\.]+S(\d+)$/i, // "Show Name S1" or "Show.Name.S1"
  ];
  
  for (const pattern of seasonPatterns) {
    const match = normalizedForParsing.match(pattern);
    if (match) {
      // Clean up the show name - replace dots/spaces with single spaces, trim
      let showName = match[1].replace(/[\.]+/g, ' ').replace(/\s+/g, ' ').trim();
      // Remove any remaining year patterns from show name (in case year wasn't extracted earlier)
      showName = showName.replace(/[\(\[](19|20)\d{2}[\)\]]/g, '').trim();
      showName = showName.replace(/\b(19|20)\d{2}\b/g, '').trim();
      showName = showName.replace(/\s+/g, ' ').trim();
      
      return {
        showName: showName,
        season: parseInt(match[2], 10),
        year: year,
      };
    }
  }
  
  // If no season pattern found, try to clean up the title and return as show name
  let cleanedTitle = normalized.replace(/[\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Remove year patterns if year was extracted
  if (year) {
    cleanedTitle = cleanedTitle.replace(/[\(\[](19|20)\d{2}[\)\]]/g, '').trim();
    cleanedTitle = cleanedTitle.replace(/\b(19|20)\d{2}\b/g, '').trim();
    cleanedTitle = cleanedTitle.replace(/\s+/g, ' ').trim();
  }
  
  return {
    showName: cleanedTitle,
    season: null,
    year: year,
  };
}

/**
 * Enrich TV show with TVDB → TMDB → IMDB IDs
 */
async function enrichTvShow(
  showName: string,
  season: number | null,
  tvdbApiKey: string | undefined,
  tmdbApiKey: string | undefined,
  omdbApiKey: string | undefined,
  braveApiKey: string | undefined,
  expectedLanguage?: string | null
): Promise<{
  tvdbId: number | null;
  tvdbSlug: string | null;
  tvdbTitle: string | null;
  tmdbId: number | null;
  tmdbTitle: string | null;
  imdbId: string | null;
  tvdbPosterUrl: string | null;
  tmdbPosterUrl: string | null;
}> {
  let tvdbId: number | null = null;
  let tvdbSlug: string | null = null;
  let tvdbTitle: string | null = null;
  let tmdbId: number | null = null;
  let tmdbTitle: string | null = null;
  let imdbId: string | null = null;
  let tvdbPosterUrl: string | null = null;
  let tmdbPosterUrl: string | null = null;

  // Step 1: Search TVDB
  if (tvdbApiKey) {
    try {
      console.log(`    Searching TVDB for: "${showName}"`);
      const tvdbResults = await tvdbClient.searchSeries(showName);
      if (tvdbResults && tvdbResults.length > 0) {
        // Score all results by title similarity and select best match
        const scoredResults = tvdbResults
          .map((series: any) => {
            const seriesName = series.name || series.title || '';
            const similarity = calculateTitleSimilarity(showName, seriesName);
            return {
              series,
              similarity,
            };
          })
          .sort((a, b) => b.similarity - a.similarity); // Sort by similarity descending
        
        const bestMatch = scoredResults[0];
        const tvdbShow = bestMatch.series;
        
        console.log(`    Selected best TVDB match: "${tvdbShow.name || tvdbShow.title}" (similarity: ${bestMatch.similarity.toFixed(3)})`);
        if (scoredResults.length > 1) {
          console.log(`    Considered ${scoredResults.length} TVDB results`);
        }
        
        // TVDB v4 API uses 'tvdb_id' or 'id' field
        tvdbId = (tvdbShow as any).tvdb_id || (tvdbShow as any).id || null;
        // Extract slug from search result (TVDB v4 API may include slug, nameSlug, or slug field)
        tvdbSlug = (tvdbShow as any).slug || (tvdbShow as any).nameSlug || (tvdbShow as any).name_slug || null;
        
        if (tvdbId) {
          console.log(`    ✓ Found TVDB ID: ${tvdbId}`);
          if (tvdbSlug) {
            console.log(`    ✓ Found TVDB slug: ${tvdbSlug}`);
          }
          
          // Get extended info for poster and other IDs
          const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
          if (tvdbExtended) {
            // Extract show title from TVDB extended info
            tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || tvdbShow.name || tvdbShow.title || null;
            
            // Extract slug from extended info if not found in search result
            if (!tvdbSlug) {
              tvdbSlug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
            }
            // Extract poster URL (TVDB v4 structure may vary)
            const artwork = (tvdbExtended as any).artwork || (tvdbExtended as any).artworks;
            if (artwork && Array.isArray(artwork)) {
              const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster'); // Type 2 is poster
              if (poster) {
                tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
              }
            }
            
            // Extract TMDB and IMDB IDs from extended info
            // TVDB v4 API uses sourceName field with values "TheMovieDB.com" and "IMDB"
            const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids;
            if (remoteIds && Array.isArray(remoteIds)) {
              const tmdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'TheMovieDB.com' || 
                r.sourceName === 'TheMovieDB' || 
                r.source_name === 'TheMovieDB.com' || 
                r.source_name === 'TheMovieDB' ||
                r.source === 'themoviedb'
              );
              const imdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'IMDB' || 
                r.source_name === 'IMDB' || 
                r.source === 'imdb'
              );
              
              if (tmdbRemote && tmdbRemote.id) {
                tmdbId = parseInt(String(tmdbRemote.id), 10);
                console.log(`    ✓ Found TMDB ID from TVDB: ${tmdbId}`);
              }
              if (imdbRemote && imdbRemote.id) {
                imdbId = String(imdbRemote.id);
                console.log(`    ✓ Found IMDB ID from TVDB: ${imdbId}`);
              }
            }
          }
        }
      }
    } catch (error: any) {
      console.log(`    ✗ TVDB search failed:`, error?.message || error);
    }
  }

  // Step 2: If TMDB ID not found, search TMDB directly
  // Note: searchTv now returns a single best match (scored by similarity)
  if (!tmdbId && tmdbApiKey) {
    try {
      console.log(`    Searching TMDB for: "${showName}"${expectedLanguage ? ` [language: ${expectedLanguage}]` : ''}`);
      const tmdbShow = await tmdbClient.searchTv(showName, expectedLanguage);
      if (tmdbShow) {
        tmdbId = tmdbShow.id;
        console.log(`    ✓ Found TMDB ID: ${tmdbId} (${tmdbShow.name})`);
        
        // Get TMDB show details for poster and IMDB ID
        if (tmdbId) {
          const tmdbShowDetails = await tmdbClient.getTvShow(tmdbId);
          if (tmdbShowDetails) {
            // Extract show title from TMDB
            tmdbTitle = tmdbShowDetails.name || null;
            
            if (tmdbShowDetails.poster_path) {
              tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShowDetails.poster_path}`;
            }
            if (tmdbShowDetails.external_ids?.imdb_id) {
              imdbId = tmdbShowDetails.external_ids.imdb_id;
              console.log(`    ✓ Found IMDB ID from TMDB: ${imdbId}`);
            }
          }
        }
      }
    } catch (error: any) {
      console.log(`    ✗ TMDB search failed:`, error?.message || error);
    }
  }

  // Step 3: If IMDB ID still not found, try OMDB
  if (!imdbId && omdbApiKey && showName) {
    try {
      console.log(`    Searching OMDB for: "${showName}"`);
      const omdbResult = await imdbClient.searchByTitle(showName, 'series');
      if (omdbResult && omdbResult.imdbId) {
        imdbId = omdbResult.imdbId;
        console.log(`    ✓ Found IMDB ID from OMDB: ${imdbId}`);
      }
    } catch (error: any) {
      console.log(`    ✗ OMDB search failed:`, error?.message || error);
    }
  }

  // Step 4: Last resort - Brave Search (if still missing IDs)
  if ((!tvdbId && !tmdbId) && braveApiKey && showName) {
    try {
      console.log(`    Searching Brave for: "${showName}"`);
      // Brave search for TVDB/TMDB IDs
      const braveResult = await braveClient.searchForTvdbId(showName);
      if (braveResult) {
        tvdbId = braveResult;
        console.log(`    ✓ Found TVDB ID from Brave: ${tvdbId}`);
        
        // Fetch title from TVDB if we have API key
        if (tvdbApiKey) {
          try {
            const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
            if (tvdbExtended) {
              tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || null;
            }
          } catch (error) {
            // Ignore errors, title is optional
          }
        }
      }
    } catch (error: any) {
      console.log(`    ✗ Brave search failed:`, error?.message || error);
    }
  }

  return {
    tvdbId,
    tvdbSlug,
    tvdbTitle,
    tmdbId,
    tmdbTitle,
    imdbId,
    tvdbPosterUrl,
    tmdbPosterUrl,
  };
}

/**
 * Check if show/season exists in Sonarr
 */
function checkSonarrShow(tvdbId: number | null, tmdbId: number | null, season: number | null): {
  exists: boolean;
  sonarrSeriesId: number | null;
  sonarrSeriesTitle: string | null;
  seasonExists: boolean;
} {
  if (!tvdbId && !tmdbId) {
    return { exists: false, sonarrSeriesId: null, sonarrSeriesTitle: null, seasonExists: false };
  }

  // Try TVDB ID first (primary for Sonarr)
  if (tvdbId) {
    const sonarrShow = getSyncedSonarrShowByTvdbId(tvdbId);
    if (sonarrShow) {
      // Check if season exists
      let seasonExists = false;
      if (season !== null && sonarrShow.seasons) {
        const seasons = Array.isArray(sonarrShow.seasons) ? sonarrShow.seasons : JSON.parse(sonarrShow.seasons);
        seasonExists = seasons.some((s: any) => s.seasonNumber === season && s.monitored);
      }
      
      return {
        exists: true,
        sonarrSeriesId: sonarrShow.sonarr_id,
        sonarrSeriesTitle: sonarrShow.title,
        seasonExists: season !== null ? seasonExists : true, // If no season specified, consider it exists
      };
    }
  }

  // Try TMDB ID as fallback (if Sonarr has it)
  if (tmdbId) {
    // Note: Sonarr primarily uses TVDB, but we can check by searching all shows
    // For now, we'll rely on TVDB ID matching
  }

  return { exists: false, sonarrSeriesId: null, sonarrSeriesTitle: null, seasonExists: false };
}

/**
 * Run TV matching engine to process TV RSS items and create tv_releases
 */
export async function runTvMatchingEngine(): Promise<TvMatchingStats> {
  const stats: TvMatchingStats = {
    totalRssItems: 0,
    processed: 0,
    newShows: 0,
    newSeasons: 0,
    existing: 0,
    ignored: 0,
    errors: 0,
  };

  const parentProgress = syncProgress.get();
  const nestedInFullSync = Boolean(parentProgress && parentProgress.isRunning && parentProgress.type === 'full');

  try {
    console.log('Starting TV matching engine...');
    if (!nestedInFullSync) {
      syncProgress.start('tv-matching', 0);
      syncProgress.update('Initializing TV matching engine...', 0);
    }
    
    const allSettings = settingsModel.getAll();
    const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key')?.value;

    if (tmdbApiKey) {
      tmdbClient.setApiKey(tmdbApiKey);
    }
    if (omdbApiKey) {
      imdbClient.setApiKey(omdbApiKey);
    }
    if (braveApiKey) {
      braveClient.setApiKey(braveApiKey);
    }

    // Get TV feeds to filter RSS items
    const tvFeeds = feedsModel.getByType('tv');
    const tvFeedIds = tvFeeds.map(f => f.id!).filter((id): id is number => id !== undefined);
    
    // Get all RSS items and filter by override or feed type
    const allRssItems = getSyncedRssItems();
    
    // Filter for TV items: feed_type_override = 'tv' OR (no override AND feed is tv)
    const tvRssItems = allRssItems.filter(item => {
      if (item.feed_type_override === 'tv') {
        return true; // Explicitly overridden to TV
      }
      if (item.feed_type_override === 'movie') {
        return false; // Explicitly overridden to movie, skip
      }
      // No override: check if feed is TV type
      return tvFeedIds.includes(item.feed_id);
    });
    
    stats.totalRssItems = tvRssItems.length;
    
    if (tvRssItems.length === 0 && tvFeedIds.length === 0) {
      console.log('No TV feeds configured and no TV overrides. Skipping TV matching engine.');
      syncProgress.update('No TV feeds configured', 0, 0);
      if (!nestedInFullSync) {
        syncProgress.complete();
      }
      return stats;
    }
    const ignoredShowKeys: Set<string> = ignoredShowsModel.getAllKeys();

    console.log(`[TV MATCHING ENGINE] Processing ${tvRssItems.length} TV RSS items from ${tvFeedIds.length} feed(s)...`);
    syncProgress.update(`Processing ${tvRssItems.length} TV RSS items...`, 0, tvRssItems.length);

    if (tvRssItems.length === 0) {
      console.log('[TV MATCHING ENGINE] No TV RSS items to process.');
      syncProgress.update('No TV RSS items to process', 0, 0);
      if (!nestedInFullSync) {
        syncProgress.complete();
      }
      return stats;
    }

    for (let i = 0; i < tvRssItems.length; i++) {
      const item = tvRssItems[i];
      try {
        if ((i + 1) % 10 === 0 || i === tvRssItems.length - 1) {
          syncProgress.update(`Processing TV items... (${i + 1}/${tvRssItems.length})`, i + 1, tvRssItems.length);
        }

        console.log(`\n[TV MATCHING ENGINE] Processing: "${item.title}"`);

        // Check if already processed
        const existingRelease = tvReleasesModel.getByGuid(item.guid);
        const preserveStatus = existingRelease && existingRelease.status === 'ADDED';
        // Preserve sonarr_series_id if it was manually set (show was added to Sonarr)
        const preserveSonarrId = existingRelease && existingRelease.sonarr_series_id;

        // Parse show name and season from title (needed for both manual and auto paths)
        let { showName, season, year } = parseTvTitle(item.title);
        console.log(`    Parsed: Show="${showName}", Season=${season !== null ? season : 'unknown'}, Year=${year || 'none'}`);

        // Get feed name to check if it's BWT TVShows
        const feed = feedsModel.getAll().find(f => f.id === item.feed_id);
        const feedName = feed?.name || '';
        
        // For BWT TVShows feed, remove year from show name (year is often inaccurate)
        if (feedName.toLowerCase().includes('bwt') && feedName.toLowerCase().includes('tv')) {
          // Remove year patterns: "2025", "(2025)", "[2025]", ".2025", " 2025", "2025 " (at end)
          // Handle year at the end of show name (common in release names like "Show Name 2025 S03")
          showName = showName
            .replace(/\s*\((\d{4})\)\s*/g, ' ') // Remove (2025)
            .replace(/\s*\[(\d{4})\]\s*/g, ' ') // Remove [2025]
            .replace(/\s*\.(\d{4})\s*/g, ' ') // Remove .2025
            .replace(/\s+(\d{4})\s+/g, ' ') // Remove standalone 2025 with spaces on both sides
            .replace(/\s+(\d{4})$/g, '') // Remove year at the end (e.g., "Show Name 2025")
            .replace(/^(\d{4})\s+/g, '') // Remove year at the start
            .replace(/\s+/g, ' ') // Normalize spaces
            .trim();
          console.log(`    Cleaned show name (removed year for BWT TVShows): "${showName}"`);
        }

        // Check if this item has manually overridden IDs - if so, use them directly
        const hasManualTvdbId = item.tvdb_id_manual && item.tvdb_id;
        const hasManualTmdbId = item.tmdb_id_manual && item.tmdb_id;
        
        let enrichment: {
          tvdbId: number | null;
          tvdbSlug: string | null;
          tvdbTitle: string | null;
          tmdbId: number | null;
          tmdbTitle: string | null;
          imdbId: string | null;
          tvdbPosterUrl: string | null;
          tmdbPosterUrl: string | null;
        };
        let sonarrShow: any = null; // Will be set if found by name search
        
        if (hasManualTvdbId || hasManualTmdbId) {
          console.log(`    ⚠ Using manually overridden IDs (TVDB: ${item.tvdb_id || 'N/A'}, TMDB: ${item.tmdb_id || 'N/A'})`);
          
          // Start with manually overridden IDs
          enrichment = {
            tvdbId: hasManualTvdbId ? item.tvdb_id : null,
            tvdbSlug: null,
            tvdbTitle: null,
            tmdbId: hasManualTmdbId ? item.tmdb_id : null,
            tmdbTitle: null,
            imdbId: item.imdb_id || null,
            tvdbPosterUrl: null,
            tmdbPosterUrl: null,
          };
          
          // Fetch extended info from TVDB if we have a TVDB ID
          if (enrichment.tvdbId && tvdbApiKey) {
            try {
              const tvdbExtended = await tvdbClient.getSeriesExtended(enrichment.tvdbId);
              if (tvdbExtended) {
                // Extract show title from TVDB extended info
                enrichment.tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || null;
                enrichment.tvdbSlug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
                
                // Extract poster URL
                const artwork = (tvdbExtended as any).artwork || (tvdbExtended as any).artworks;
                if (artwork && Array.isArray(artwork)) {
                  const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster');
                  if (poster) {
                    enrichment.tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
                  }
                }
                
                // Extract TMDB/IMDB IDs from TVDB if not already set
                // TVDB v4 API uses sourceName field with values "TheMovieDB.com" and "IMDB"
                const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids;
                if (remoteIds && Array.isArray(remoteIds)) {
                  if (!enrichment.tmdbId) {
                    const tmdbRemote = remoteIds.find((r: any) => 
                      r.sourceName === 'TheMovieDB.com' || 
                      r.sourceName === 'TheMovieDB' || 
                      r.source_name === 'TheMovieDB.com' || 
                      r.source_name === 'TheMovieDB' ||
                      r.source === 'themoviedb'
                    );
                    if (tmdbRemote && tmdbRemote.id) {
                      enrichment.tmdbId = parseInt(String(tmdbRemote.id), 10);
                      console.log(`    ✓ Found TMDB ID from TVDB extended info: ${enrichment.tmdbId}`);
                    }
                  }
                  if (!enrichment.imdbId) {
                    const imdbRemote = remoteIds.find((r: any) => 
                      r.sourceName === 'IMDB' || 
                      r.source_name === 'IMDB' || 
                      r.source === 'imdb'
                    );
                    if (imdbRemote && imdbRemote.id) {
                      enrichment.imdbId = String(imdbRemote.id);
                      console.log(`    ✓ Found IMDB ID from TVDB extended info: ${enrichment.imdbId}`);
                    }
                  }
                }
              }
            } catch (error) {
              console.log(`    ⚠ Failed to fetch TVDB extended info for ID ${enrichment.tvdbId}:`, error);
            }
          }
          
          // Fetch TMDB poster if we have a TMDB ID
          if (enrichment.tmdbId && tmdbApiKey) {
            try {
              const tmdbShow = await tmdbClient.getTvShow(enrichment.tmdbId);
              if (tmdbShow) {
                // Extract show title from TMDB
                enrichment.tmdbTitle = tmdbShow.name || null;
                
                if (tmdbShow.poster_path) {
                  enrichment.tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}`;
                }
                if (tmdbShow.external_ids?.imdb_id && !enrichment.imdbId) {
                  enrichment.imdbId = tmdbShow.external_ids.imdb_id;
                }
              }
            } catch (error) {
              console.log(`    ⚠ Failed to fetch TMDB show for ID ${enrichment.tmdbId}:`, error);
            }
          }
          
          console.log(`    ✓ Using manual override IDs: TVDB=${enrichment.tvdbId || 'N/A'}, TMDB=${enrichment.tmdbId || 'N/A'}, IMDB=${enrichment.imdbId || 'N/A'}`);
        } else {
          // No manual overrides - proceed with normal matching flow
          // Step 1: First try to match with Sonarr by show name (without year)
          console.log(`    Searching Sonarr for: "${showName}"`);
          sonarrShow = findSonarrShowByName(showName);
          
          if (sonarrShow) {
            console.log(`    ✓ Found in Sonarr: "${sonarrShow.title}" (Sonarr ID: ${sonarrShow.sonarr_id})`);
            
            // Use IDs from Sonarr (slug will be null, we'll need to fetch it if needed)
            enrichment = {
              tvdbId: sonarrShow.tvdb_id || null,
              tvdbSlug: null, // Not available from Sonarr, will need to fetch from TVDB API if needed
              tvdbTitle: sonarrShow.title || null, // Use Sonarr title as TVDB title
              tmdbId: sonarrShow.tmdb_id || null,
              tmdbTitle: null,
              imdbId: sonarrShow.imdb_id || null,
              tvdbPosterUrl: null, // Will extract from images if available
              tmdbPosterUrl: null, // Will extract from images if available
            };
            
            // If we have TVDB ID from Sonarr, try to get slug and title from TVDB API
            if (enrichment.tvdbId && tvdbApiKey) {
              try {
                const tvdbExtended = await tvdbClient.getSeriesExtended(enrichment.tvdbId);
                if (tvdbExtended) {
                  // Update title from TVDB if available (more accurate than Sonarr title)
                  enrichment.tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || enrichment.tvdbTitle;
                  enrichment.tvdbSlug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
                }
              } catch (error) {
                // Silently fail, slug is optional
              }
            }
            
            // Extract poster URLs from Sonarr images
            if (sonarrShow.images && Array.isArray(sonarrShow.images)) {
              const poster = sonarrShow.images.find((img: any) => img.coverType === 'poster');
              if (poster) {
                enrichment.tvdbPosterUrl = poster.remoteUrl || poster.url || null;
                enrichment.tmdbPosterUrl = poster.remoteUrl || poster.url || null;
              }
            }
            
            console.log(`    Using Sonarr IDs: TVDB=${enrichment.tvdbId || 'N/A'}, TMDB=${enrichment.tmdbId || 'N/A'}, IMDB=${enrichment.imdbId || 'N/A'}`);
          } else {
            console.log(`    ✗ Not found in Sonarr, using external API enrichment`);
            
            // Step 2: If not in Sonarr, enrich with TVDB → TMDB → IMDB
            // Extract language from RSS item if available
            const expectedLanguage = getLanguageFromRssItem({
              audio_languages: item.audio_languages,
              title: item.title,
            });
            
            enrichment = await enrichTvShow(
              showName,
              season,
              tvdbApiKey,
              tmdbApiKey,
              omdbApiKey,
              braveApiKey,
              expectedLanguage
            );
          }
        }

        // Check if show/season exists in Sonarr (using the IDs we have or the show we found by name)
        let sonarrCheck: {
          exists: boolean;
          sonarrSeriesId: number | null;
          sonarrSeriesTitle: string | null;
          seasonExists: boolean;
        };
        
        if (sonarrShow) {
          // We found the show by name, use that info
          let seasonExists = false;
          if (season !== null && sonarrShow.seasons) {
            const seasons = Array.isArray(sonarrShow.seasons) ? sonarrShow.seasons : JSON.parse(sonarrShow.seasons);
            seasonExists = seasons.some((s: any) => s.seasonNumber === season && s.monitored);
          }
          
          sonarrCheck = {
            exists: true,
            sonarrSeriesId: sonarrShow.sonarr_id,
            sonarrSeriesTitle: sonarrShow.title,
            seasonExists: season !== null ? seasonExists : true,
          };
        } else {
          // Check by IDs (for shows found via external APIs)
          sonarrCheck = checkSonarrShow(enrichment.tvdbId, enrichment.tmdbId, season);
          
          // If we have a preserved sonarr_series_id but checkSonarrShow didn't find it
          // (e.g., Sonarr sync hasn't run yet), preserve the existing ID
          if (preserveSonarrId && !sonarrCheck.exists && existingRelease && existingRelease.sonarr_series_id) {
            console.log(`    ⚠ Preserving sonarr_series_id ${existingRelease.sonarr_series_id} (show was manually added, Sonarr sync may not have run yet)`);
            sonarrCheck = {
              exists: true, // Treat as existing since it was manually added
              sonarrSeriesId: existingRelease.sonarr_series_id,
              sonarrSeriesTitle: existingRelease.sonarr_series_title || null,
              seasonExists: true, // Assume season exists if manually added
            };
          }
        }

        // Determine status
        let status: TvReleaseStatus = 'NEW_SHOW';
        if (sonarrCheck.exists) {
          if (season !== null && !sonarrCheck.seasonExists) {
            status = 'NEW_SEASON';
            stats.newSeasons++;
          } else {
            // Show and season already exist in Sonarr - these are likely duplicates
            // or already handled by Sonarr, so mark as IGNORED
            status = 'IGNORED';
            stats.existing++;
          }
        } else {
          stats.newShows++;
        }

        const showKey = buildShowKey({
          tvdbId: enrichment.tvdbId || item.tvdb_id || null,
          tmdbId: enrichment.tmdbId || item.tmdb_id || null,
          showName,
        });
        const showManuallyIgnored = showKey ? ignoredShowKeys.has(showKey) : false;
        if (showManuallyIgnored) {
          status = 'IGNORED';
        }

        // Preserve ADDED status if it was manually added
        const finalStatus = preserveStatus ? 'ADDED' : status;

        // Create or update tv_release
        // Preserve sonarr_series_id if it was manually set (show was added to Sonarr)
        // even if checkSonarrShow didn't find it (Sonarr sync may not have run yet)
        const finalSonarrSeriesId: number | undefined = preserveSonarrId && existingRelease?.sonarr_series_id 
          ? existingRelease.sonarr_series_id 
          : (sonarrCheck.sonarrSeriesId ?? undefined);
        const finalSonarrSeriesTitle: string | undefined = preserveSonarrId && existingRelease?.sonarr_series_title
          ? existingRelease.sonarr_series_title
          : (sonarrCheck.sonarrSeriesTitle ?? undefined);
        
        // Use actual show title from TVDB/TMDB if available, otherwise fallback to parsed showName
        const actualShowName = enrichment.tvdbTitle || enrichment.tmdbTitle || showName;
        
        const tvRelease: Omit<TvRelease, 'id'> = {
          guid: String(item.guid || ''),
          title: String(item.title || ''),
          normalized_title: String(item.normalized_title || ''),
          show_name: actualShowName,
          season_number: season ?? undefined,
          source_site: String(item.source_site || ''),
          feed_id: Number(item.feed_id || 0),
          link: String(item.link || ''),
          published_at: String(item.published_at || new Date().toISOString()),
          tvdb_id: enrichment.tvdbId ?? undefined,
          tvdb_slug: enrichment.tvdbSlug ?? undefined,
          tmdb_id: enrichment.tmdbId ?? undefined,
          imdb_id: enrichment.imdbId ?? undefined,
          tvdb_poster_url: enrichment.tvdbPosterUrl ?? undefined,
          tmdb_poster_url: enrichment.tmdbPosterUrl ?? undefined,
          sonarr_series_id: finalSonarrSeriesId,
          sonarr_series_title: finalSonarrSeriesTitle,
          status: finalStatus,
          last_checked_at: new Date().toISOString(),
          manually_ignored: showManuallyIgnored,
        };

        tvReleasesModel.upsert(tvRelease);
        
        // Also update rss_feed_items with the enriched IDs (unless manually overridden)
        const rssItem = db.prepare('SELECT * FROM rss_feed_items WHERE guid = ?').get(item.guid) as any;
        if (rssItem) {
          // Only update if not manually set (respect manual overrides)
          const updateFields: string[] = [];
          const updateValues: any[] = [];
          
          if (enrichment.tvdbId && !rssItem.tvdb_id_manual) {
            updateFields.push('tvdb_id = ?');
            updateValues.push(enrichment.tvdbId);
          }
          if (enrichment.tmdbId && !rssItem.tmdb_id_manual) {
            updateFields.push('tmdb_id = ?');
            updateValues.push(enrichment.tmdbId);
          }
          if (enrichment.imdbId && !rssItem.imdb_id_manual) {
            updateFields.push('imdb_id = ?');
            updateValues.push(enrichment.imdbId);
          }
          
          if (updateFields.length > 0) {
            updateValues.push(item.guid);
            db.prepare(`
              UPDATE rss_feed_items 
              SET ${updateFields.join(', ')}, updated_at = datetime('now')
              WHERE guid = ?
            `).run(...updateValues);
          }
        }
        
        stats.processed++;

        console.log(`    ✓ Created/updated TV release: ${showName} ${season !== null ? `S${season}` : ''} (Status: ${finalStatus})`);
      } catch (error: any) {
        console.error(`[TV MATCHING ENGINE] Error processing item "${item.title}":`, error);
        stats.errors++;
      }
    }

    // Save last run timestamp
    settingsModel.set('tv_matching_last_run', new Date().toISOString());

    console.log(`[TV MATCHING ENGINE] Completed: ${stats.processed} processed, ${stats.newShows} new shows, ${stats.newSeasons} new seasons, ${stats.existing} existing, ${stats.errors} errors`);
    
    const details: string[] = [];
    if (stats.newShows > 0) {
      details.push(`${stats.newShows} new show(s)`);
    }
    if (stats.newSeasons > 0) {
      details.push(`${stats.newSeasons} new season(s)`);
    }
    if (stats.existing > 0) {
      details.push(`${stats.existing} existing`);
    }

    syncProgress.update(
      `TV matching completed: ${stats.processed} processed`,
      tvRssItems.length,
      tvRssItems.length,
      stats.errors,
      details.length > 0 ? details : undefined
    );
    if (!nestedInFullSync) {
      syncProgress.complete();
    }

    return stats;
  } catch (error: any) {
    console.error('[TV MATCHING ENGINE] Error:', error);
    if (!nestedInFullSync) {
      syncProgress.error(`TV matching failed: ${error?.message || 'Unknown error'}`);
    }
    throw error;
  }
}

