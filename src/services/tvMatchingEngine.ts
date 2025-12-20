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
  expectedLanguage?: string | null,
  year?: number | null
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
  
  // Store candidate TVDB data for cross-validation
  let candidateTvdbData: { id: number; slug: string | null; tmdbId: number | null; imdbId: string | null } | null = null;

  // Step 1: Search TVDB
  if (tvdbApiKey) {
    try {
      console.log(`    Searching TVDB for: "${showName}"`);
      const tvdbResults = await tvdbClient.searchSeries(showName);
      if (tvdbResults && tvdbResults.length > 0) {
        // Import validation functions
        const { validateShowNameMatch, validateYearMatch } = await import('../utils/titleSimilarity');
        
        // Score all results by title similarity and select best match
        const scoredResults = tvdbResults
          .map((series: any) => {
            const seriesName = series.name || series.title || '';
            const similarity = calculateTitleSimilarity(showName, seriesName);
            const seriesYear = series.year || series.firstAired ? (series.firstAired as string).substring(0, 4) : null;
            
            return {
              series,
              similarity,
              seriesName,
              seriesYear,
            };
          })
          .filter((result: any) => {
            // Apply similarity threshold (minimum 0.5 for consideration)
            if (result.similarity < 0.5) {
              console.log(`    Rejected "${result.seriesName}" - similarity too low (${result.similarity.toFixed(3)})`);
              return false;
            }
            
            // Validate show name match (key words must be present)
            if (!validateShowNameMatch(showName, result.seriesName)) {
              console.log(`    Rejected "${result.seriesName}" - key words missing from "${showName}"`);
              return false;
            }
            
            // Validate year match if we have year information
            if (season === null && year) {
              if (!validateYearMatch(year, result.seriesYear)) {
                console.log(`    Rejected "${result.seriesName}" - year mismatch (parsed: ${year}, matched: ${result.seriesYear})`);
                return false;
              }
            }
            
            return true;
          })
          .sort((a: any, b: any) => {
            // Sort by similarity, but also consider year match
            if (season === null && year) {
              const aYearMatch = validateYearMatch(year, a.seriesYear) ? 0.1 : 0;
              const bYearMatch = validateYearMatch(year, b.seriesYear) ? 0.1 : 0;
              return (b.similarity + bYearMatch) - (a.similarity + aYearMatch);
            }
            return b.similarity - a.similarity;
          }); // Sort by similarity descending
        
        if (scoredResults.length === 0) {
          console.log(`    ✗ No TVDB results passed validation (similarity threshold, name validation, year check)`);
        } else {
          const bestMatch = scoredResults[0];
          const tvdbShow = bestMatch.series;
          
          console.log(`    Selected best TVDB match: "${tvdbShow.name || tvdbShow.title}" (similarity: ${bestMatch.similarity.toFixed(3)})`);
          if (scoredResults.length > 1) {
            console.log(`    Considered ${scoredResults.length} TVDB results (from ${tvdbResults.length} total)`);
          }
          
          // TVDB v4 API uses 'tvdb_id' or 'id' field
          const candidateTvdbId = (tvdbShow as any).tvdb_id || (tvdbShow as any).id || null;
          // Extract slug from search result (TVDB v4 API may include slug, nameSlug, or slug field)
          const candidateTvdbSlug = (tvdbShow as any).slug || (tvdbShow as any).nameSlug || (tvdbShow as any).name_slug || null;
          
          if (candidateTvdbId) {
          console.log(`    ✓ Found candidate TVDB ID: ${candidateTvdbId}`);
          if (candidateTvdbSlug) {
            console.log(`    ✓ Found candidate TVDB slug: ${candidateTvdbSlug}`);
          }
          
          // Get extended info for poster and other IDs
          const tvdbExtended = await tvdbClient.getSeriesExtended(candidateTvdbId);
          if (tvdbExtended) {
            // Extract show title from TVDB extended info
            // TVDB returns original language name, so we'll prefer TMDB English title when available
            // For now, store the original name but we'll replace it with TMDB English title later
            tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || tvdbShow.name || tvdbShow.title || null;
            
            // Extract slug from extended info if not found in search result
            const finalTvdbSlug = candidateTvdbSlug || (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
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
            let tvdbTmdbId: number | null = null;
            let tvdbImdbId: string | null = null;
            
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
                tvdbTmdbId = parseInt(String(tmdbRemote.id), 10);
              }
              if (imdbRemote && imdbRemote.id) {
                tvdbImdbId = String(imdbRemote.id);
              }
            }
            
            // Store candidate TVDB data for cross-validation after TMDB search
            candidateTvdbData = {
              id: candidateTvdbId,
              slug: finalTvdbSlug,
              tmdbId: tvdbTmdbId,
              imdbId: tvdbImdbId,
            };
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
        // Validate the match before accepting it
        const { validateShowNameMatch, validateYearMatch } = await import('../utils/titleSimilarity');
        const tmdbShowName = tmdbShow.name || '';
        const tmdbYear = tmdbShow.first_air_date ? parseInt(tmdbShow.first_air_date.substring(0, 4), 10) : null;
        
        // Check similarity threshold and name validation
        const similarity = calculateTitleSimilarity(showName, tmdbShowName);
        if (similarity < 0.5) {
          console.log(`    ✗ Rejected TMDB match "${tmdbShowName}" - similarity too low (${similarity.toFixed(3)})`);
        } else if (!validateShowNameMatch(showName, tmdbShowName)) {
          console.log(`    ✗ Rejected TMDB match "${tmdbShowName}" - key words missing from "${showName}"`);
        } else if (season === null && year && !validateYearMatch(year, tmdbYear)) {
          console.log(`    ✗ Rejected TMDB match "${tmdbShowName}" - year mismatch (parsed: ${year}, matched: ${tmdbYear})`);
        } else {
          tmdbId = tmdbShow.id;
          console.log(`    ✓ Found TMDB ID: ${tmdbId} (${tmdbShow.name}, similarity: ${similarity.toFixed(3)})`);
          
          // Get TMDB show details for poster and IMDB ID
          if (tmdbId) {
            const tmdbShowDetails = await tmdbClient.getTvShow(tmdbId);
            if (tmdbShowDetails) {
              // Extract show title from TMDB (typically in English)
              tmdbTitle = tmdbShowDetails.name || null;
              
              // Always prefer TMDB English title over TVDB original language title
              if (tmdbTitle) {
                tvdbTitle = tmdbTitle; // Use TMDB English title instead of TVDB original language
              }
              
              if (tmdbShowDetails.poster_path) {
                tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShowDetails.poster_path}`;
              }
              if (tmdbShowDetails.external_ids?.imdb_id) {
                imdbId = tmdbShowDetails.external_ids.imdb_id;
                console.log(`    ✓ Found IMDB ID from TMDB: ${imdbId}`);
              }
              
              // Cross-validate TVDB match: if we have a candidate TVDB match, check if its TMDB ID matches
              if (candidateTvdbData) {
                if (candidateTvdbData.tmdbId && candidateTvdbData.tmdbId !== tmdbId) {
                  console.log(`    ⚠️ TVDB match rejected - TMDB ID mismatch: TVDB candidate has ${candidateTvdbData.tmdbId}, but TMDB search found ${tmdbId}`);
                  // Reject the TVDB match
                  candidateTvdbData = null;
                } else if (candidateTvdbData.imdbId && imdbId && candidateTvdbData.imdbId !== imdbId) {
                  console.log(`    ⚠️ TVDB match rejected - IMDB ID mismatch: TVDB candidate has ${candidateTvdbData.imdbId}, but TMDB search found ${imdbId}`);
                  // Reject the TVDB match
                  candidateTvdbData = null;
                } else {
                  // TVDB match is valid, use it
                  tvdbId = candidateTvdbData.id;
                  tvdbSlug = candidateTvdbData.slug;
                  console.log(`    ✓ TVDB match validated - IDs match: TVDB ID ${tvdbId}, TMDB ID ${tmdbId}`);
                }
              }
              
              // If TVDB match was rejected, try to find correct TVDB ID from TMDB external_ids
              if (!tvdbId && tmdbShowDetails.external_ids?.tvdb_id && tvdbApiKey) {
                try {
                  const correctTvdbId = tmdbShowDetails.external_ids.tvdb_id;
                  console.log(`    🔍 Attempting to find correct TVDB ID from TMDB external_ids: ${correctTvdbId}`);
                  const correctTvdbExtended = await tvdbClient.getSeriesExtended(correctTvdbId);
                  if (correctTvdbExtended) {
                    tvdbId = correctTvdbId;
                    tvdbSlug = (correctTvdbExtended as any).slug || (correctTvdbExtended as any).nameSlug || (correctTvdbExtended as any).name_slug || null;
                    console.log(`    ✓ Found correct TVDB ID from TMDB: ${tvdbId}${tvdbSlug ? ` (slug: ${tvdbSlug})` : ''}`);
                    
                    // Get poster from correct TVDB entry
                    const artwork = (correctTvdbExtended as any).artwork || (correctTvdbExtended as any).artworks;
                    if (artwork && Array.isArray(artwork)) {
                      const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster');
                      if (poster) {
                        tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
                      }
                    }
                  }
                } catch (error) {
                  console.log(`    ⚠️ Could not fetch correct TVDB ID from TMDB:`, error);
                }
              }
            }
          }
        }
      }
    } catch (error: any) {
      console.log(`    ✗ TMDB search failed:`, error?.message || error);
    }
  }

  // If we still have a candidate TVDB match that wasn't validated, use it now
  // (This happens when TMDB search didn't find a match, so we can't cross-validate)
  if (!tvdbId && candidateTvdbData) {
    tvdbId = candidateTvdbData.id;
    tvdbSlug = candidateTvdbData.slug;
    console.log(`    ✓ Using TVDB match (no TMDB cross-validation available): TVDB ID ${tvdbId}`);
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
        // Preserve sonarr_series_id only if TVDB ID hasn't changed (to avoid preserving wrong show's ID)
        // We'll check this later after we have the enrichment data

        // Parse show name and season from title (needed for both manual and auto paths)
        let { showName, season, year } = parseTvTitle(item.title);
        console.log(`    Parsed: Show="${showName}", Season=${season !== null ? season : 'unknown'}, Year=${year || 'none'}`);

        // Get feed name to check if it's BWT TVShows
        const feed = feedsModel.getAll().find(f => f.id === item.feed_id);
        const feedName = feed?.name || '';
        
        // For BWT TVShows feed, remove year from show name (year is often inaccurate)
        // BUT: Be careful not to remove years that are part of the show name (e.g., "90's A Middle Class Biopic")
        if (feedName.toLowerCase().includes('bwt') && feedName.toLowerCase().includes('tv')) {
          // Only remove year if it's clearly a release year (at the end, standalone, or in parentheses)
          // Don't remove years that are part of phrases like "90's" or "1992"
          const originalShowName = showName;
          showName = showName
            .replace(/\s*\((\d{4})\)\s*/g, ' ') // Remove (2025) in parentheses
            .replace(/\s*\[(\d{4})\]\s*/g, ' ') // Remove [2025] in brackets
            .replace(/\s+(\d{4})$/g, '') // Remove year at the very end (e.g., "Show Name 2025")
            .replace(/^(\d{4})\s+/g, '') // Remove year at the very start
            .replace(/\s+/g, ' ') // Normalize spaces
            .trim();
          
          // If we removed too much (e.g., "90's" became empty or too short), revert
          if (showName.length < 3 || (originalShowName.includes("'s") && !showName.includes("'s"))) {
            showName = originalShowName; // Keep original if we broke it
            console.log(`    Kept original show name (year might be part of title): "${showName}"`);
          } else if (showName !== originalShowName) {
            console.log(`    Cleaned show name (removed year for BWT TVShows): "${showName}"`);
          }
        }

        // If we have an existing release, validate its IDs for consistency
        let needsRevalidation: boolean = false;
        if (existingRelease && existingRelease.tvdb_id && tvdbApiKey) {
          try {
            console.log(`    Validating existing release IDs for TVDB ID ${existingRelease.tvdb_id}...`);
            const tvdbExtended = await tvdbClient.getSeriesExtended(existingRelease.tvdb_id);
            if (tvdbExtended) {
              const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids || [];
              const tmdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'TheMovieDB.com' || r.sourceName === 'TheMovieDB' ||
                r.source_name === 'TheMovieDB.com' || r.source_name === 'TheMovieDB' ||
                r.source === 'themoviedb'
              );
              const imdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'IMDB' || r.source_name === 'IMDB' || r.source === 'imdb'
              );
              
              // Check for ID mismatches
              if (tmdbRemote && tmdbRemote.id) {
                const tvdbTmdbId = parseInt(String(tmdbRemote.id), 10);
                if (existingRelease.tmdb_id && existingRelease.tmdb_id !== tvdbTmdbId) {
                  console.log(`    ⚠️ ID MISMATCH DETECTED: Existing TMDB ID ${existingRelease.tmdb_id} doesn't match TVDB's ${tvdbTmdbId}`);
                  needsRevalidation = true;
                }
              }
              
              if (imdbRemote && imdbRemote.id) {
                const tvdbImdbId = String(imdbRemote.id);
                if (existingRelease.imdb_id && existingRelease.imdb_id !== tvdbImdbId) {
                  console.log(`    ⚠️ ID MISMATCH DETECTED: Existing IMDB ID ${existingRelease.imdb_id} doesn't match TVDB's ${tvdbImdbId}`);
                  needsRevalidation = true;
                }
              }
              
              // Also validate show name matches - use English title from TMDB if available
              // TVDB returns original language name, so we need to get English from TMDB
              let tvdbShowName = (tvdbExtended as any).name || (tvdbExtended as any).title || '';
              
              // Always try to get English title from TMDB (TVDB returns original language)
              if (tmdbRemote && tmdbRemote.id && tmdbApiKey) {
                try {
                  const tmdbShow = await tmdbClient.getTvShow(parseInt(String(tmdbRemote.id), 10));
                  if (tmdbShow && tmdbShow.name) {
                    tvdbShowName = tmdbShow.name; // Use English title from TMDB
                  }
                } catch (error) {
                  // Ignore errors, use TVDB title
                }
              }
              
              if (existingRelease.show_name && tvdbShowName) {
                const { validateShowNameMatch } = await import('../utils/titleSimilarity');
                if (!validateShowNameMatch(existingRelease.show_name, tvdbShowName)) {
                  console.log(`    ⚠️ SHOW NAME MISMATCH: Existing "${existingRelease.show_name}" doesn't match TVDB/TMDB "${tvdbShowName}"`);
                  needsRevalidation = true;
                }
              }
            }
          } catch (error) {
            console.log(`    ⚠️ Could not validate existing release IDs:`, error);
          }
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
                // Extract show title from TVDB extended info (will prefer TMDB English title later if available)
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
          // Also validate ID consistency
          if (enrichment.tmdbId && tmdbApiKey) {
            try {
              const tmdbShow = await tmdbClient.getTvShow(enrichment.tmdbId);
              if (tmdbShow) {
                // Extract show title from TMDB (typically in English)
                enrichment.tmdbTitle = tmdbShow.name || null;
                
                // Always use TMDB English title instead of TVDB original language title
                if (enrichment.tmdbTitle) {
                  enrichment.tvdbTitle = enrichment.tmdbTitle; // Use English title
                }
                
                if (tmdbShow.poster_path) {
                  enrichment.tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}`;
                }
                
                // Validate IMDB ID consistency
                if (tmdbShow.external_ids?.imdb_id) {
                  if (enrichment.imdbId && enrichment.imdbId !== tmdbShow.external_ids.imdb_id) {
                    console.log(`    ⚠️ IMDB ID mismatch: Manual override has ${enrichment.imdbId}, TMDB says ${tmdbShow.external_ids.imdb_id} - using TMDB`);
                    enrichment.imdbId = tmdbShow.external_ids.imdb_id;
                  } else if (!enrichment.imdbId) {
                    enrichment.imdbId = tmdbShow.external_ids.imdb_id;
                  }
                }
                
                // Validate TVDB ID consistency if we have one
                if (enrichment.tvdbId && tmdbShow.external_ids?.tvdb_id) {
                  if (enrichment.tvdbId !== tmdbShow.external_ids.tvdb_id) {
                    console.log(`    ⚠️ TVDB ID mismatch: Manual override has ${enrichment.tvdbId}, TMDB says ${tmdbShow.external_ids.tvdb_id} - keeping manual override`);
                    // Keep manual override as it's explicitly set by user
                  }
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
              tvdbTitle: sonarrShow.title || null, // Use Sonarr title as initial TVDB title
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
                  // Update title from TVDB if available (will prefer TMDB English title later if available)
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
              expectedLanguage,
              year
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
          
          // Only preserve sonarr_series_id if:
          // 1. We have an existing release with sonarr_series_id
          // 2. The TVDB ID hasn't changed (same show)
          // 3. checkSonarrShow didn't find it (might be sync timing issue)
          const tvdbIdUnchanged = existingRelease && 
            existingRelease.tvdb_id && 
            enrichment.tvdbId && 
            existingRelease.tvdb_id === enrichment.tvdbId;
          
          if (tvdbIdUnchanged && !sonarrCheck.exists && existingRelease && existingRelease.sonarr_series_id) {
            // Verify the sonarr_series_id actually points to a show with matching TVDB ID
            const preservedSonarrShow = getSyncedSonarrShowBySonarrId(existingRelease.sonarr_series_id);
            if (preservedSonarrShow && preservedSonarrShow.tvdb_id === enrichment.tvdbId) {
              console.log(`    ⚠ Preserving sonarr_series_id ${existingRelease.sonarr_series_id} (TVDB ID matches, Sonarr sync may not have run yet)`);
              sonarrCheck = {
                exists: true, // Treat as existing since TVDB ID matches
                sonarrSeriesId: existingRelease.sonarr_series_id,
                sonarrSeriesTitle: existingRelease.sonarr_series_title || preservedSonarrShow.title || null,
                seasonExists: true, // Assume season exists if manually added
              };
            } else {
              console.log(`    ⚠ Clearing sonarr_series_id ${existingRelease.sonarr_series_id} - TVDB ID changed or show not found in Sonarr`);
            }
          } else if (existingRelease && existingRelease.sonarr_series_id && !tvdbIdUnchanged) {
            console.log(`    ⚠ Clearing sonarr_series_id ${existingRelease.sonarr_series_id} - TVDB ID changed from ${existingRelease.tvdb_id} to ${enrichment.tvdbId}`);
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
        // Only preserve sonarr_series_id if:
        // 1. checkSonarrShow found it (show exists in Sonarr), OR
        // 2. TVDB ID hasn't changed and we have a preserved ID (sync timing issue)
        // Otherwise, clear it (TVDB ID changed or show was removed from Sonarr)
        const finalSonarrSeriesId: number | undefined = sonarrCheck.exists 
          ? (sonarrCheck.sonarrSeriesId ?? undefined)
          : undefined; // Clear if not found
        const finalSonarrSeriesTitle: string | undefined = sonarrCheck.exists
          ? (sonarrCheck.sonarrSeriesTitle ?? undefined)
          : undefined; // Clear if not found
        
        // If we detected ID mismatches in existing release, force re-enrichment BEFORE creating tvRelease
        // This must happen before we determine actualShowName and create tvRelease
        if (needsRevalidation && !hasManualTvdbId && !hasManualTmdbId) {
          console.log(`    🔄 Re-enriching due to ID mismatches detected in existing release...`);
          // Re-run enrichment to get correct IDs
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
            expectedLanguage,
            year
          );
          console.log(`    ✓ Re-enrichment complete: TVDB=${enrichment.tvdbId || 'N/A'}, TMDB=${enrichment.tmdbId || 'N/A'}, IMDB=${enrichment.imdbId || 'N/A'}`);
        }
        
        // Use actual show title from TMDB (English) or TVDB, otherwise fallback to parsed showName
        // Prefer TMDB title as it's typically in English, then TVDB title, then parsed showName
        const actualShowName = enrichment.tmdbTitle || enrichment.tvdbTitle || showName;
        
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
          tvdb_title: enrichment.tvdbTitle ?? undefined,
          tmdb_id: enrichment.tmdbId ?? undefined,
          tmdb_title: enrichment.tmdbTitle ?? undefined,
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

