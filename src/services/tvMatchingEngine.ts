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
 * Parse TV show title to extract show name and season number
 * Examples:
 *   "Show Name S01" -> { showName: "Show Name", season: 1 }
 *   "Show Name Season 1" -> { showName: "Show Name", season: 1 }
 *   "Show Name S1E1" -> { showName: "Show Name", season: 1 }
 */
function parseTvTitle(title: string): { showName: string; season: number | null } {
  const normalized = title.trim();
  
  // First, normalize dots to spaces for better matching (common in release names)
  // Replace dots with spaces, but preserve common patterns like "S03", "S01E01", etc.
  const normalizedForParsing = normalized.replace(/\./g, ' ');
  
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
      const showName = match[1].replace(/[\.]+/g, ' ').replace(/\s+/g, ' ').trim();
      return {
        showName: showName,
        season: parseInt(match[2], 10),
      };
    }
  }
  
  // If no season pattern found, try to clean up the title and return as show name
  const cleanedTitle = normalized.replace(/[\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    showName: cleanedTitle,
    season: null,
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
  braveApiKey: string | undefined
): Promise<{
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbPosterUrl: string | null;
  tmdbPosterUrl: string | null;
}> {
  let tvdbId: number | null = null;
  let tmdbId: number | null = null;
  let imdbId: string | null = null;
  let tvdbPosterUrl: string | null = null;
  let tmdbPosterUrl: string | null = null;

  // Step 1: Search TVDB
  if (tvdbApiKey) {
    try {
      console.log(`    Searching TVDB for: "${showName}"`);
      const tvdbResults = await tvdbClient.searchSeries(showName);
      if (tvdbResults && tvdbResults.length > 0) {
        // Take the first result (best match)
        const tvdbShow = tvdbResults[0];
        // TVDB v4 API uses 'tvdb_id' or 'id' field
        tvdbId = (tvdbShow as any).tvdb_id || (tvdbShow as any).id || null;
        
        if (tvdbId) {
          console.log(`    ✓ Found TVDB ID: ${tvdbId}`);
          
          // Get extended info for poster and other IDs
          const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
          if (tvdbExtended) {
            // Extract poster URL (TVDB v4 structure may vary)
            const artwork = (tvdbExtended as any).artwork || (tvdbExtended as any).artworks;
            if (artwork && Array.isArray(artwork)) {
              const poster = artwork.find((a: any) => a.type === 2 || a.imageType === 'poster'); // Type 2 is poster
              if (poster) {
                tvdbPosterUrl = poster.image || poster.url || poster.thumbnail || null;
              }
            }
            
            // Extract TMDB and IMDB IDs from extended info
            const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids;
            if (remoteIds && Array.isArray(remoteIds)) {
              const tmdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'TheMovieDB' || r.source_name === 'TheMovieDB' || r.source === 'themoviedb'
              );
              const imdbRemote = remoteIds.find((r: any) => 
                r.sourceName === 'IMDB' || r.source_name === 'IMDB' || r.source === 'imdb'
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
  if (!tmdbId && tmdbApiKey) {
    try {
      console.log(`    Searching TMDB for: "${showName}"`);
      const tmdbResults = await tmdbClient.searchTv(showName);
      if (tmdbResults && tmdbResults.length > 0) {
        tmdbId = tmdbResults[0].id;
        console.log(`    ✓ Found TMDB ID: ${tmdbId}`);
        
        // Get TMDB show details for poster and IMDB ID
        if (tmdbId) {
          const tmdbShow = await tmdbClient.getTvShow(tmdbId);
          if (tmdbShow) {
          if (tmdbShow.poster_path) {
            tmdbPosterUrl = `https://image.tmdb.org/t/p/w500${tmdbShow.poster_path}`;
          }
          if (tmdbShow.external_ids?.imdb_id) {
            imdbId = tmdbShow.external_ids.imdb_id;
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
      }
    } catch (error: any) {
      console.log(`    ✗ Brave search failed:`, error?.message || error);
    }
  }

  return {
    tvdbId,
    tmdbId,
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

  try {
    console.log('Starting TV matching engine...');
    syncProgress.start('tv-matching', 0);
    syncProgress.update('Initializing TV matching engine...', 0);
    
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
    
    if (tvFeedIds.length === 0) {
      console.log('No TV feeds configured. Skipping TV matching engine.');
      syncProgress.update('No TV feeds configured', 0, 0);
      syncProgress.complete();
      return stats;
    }

    // Get all RSS items from TV feeds
    const allRssItems = getSyncedRssItems();
    const tvRssItems = allRssItems.filter(item => tvFeedIds.includes(item.feed_id));
    stats.totalRssItems = tvRssItems.length;

    console.log(`[TV MATCHING ENGINE] Processing ${tvRssItems.length} TV RSS items from ${tvFeedIds.length} feed(s)...`);
    syncProgress.update(`Processing ${tvRssItems.length} TV RSS items...`, 0, tvRssItems.length);

    if (tvRssItems.length === 0) {
      console.log('[TV MATCHING ENGINE] No TV RSS items to process.');
      syncProgress.update('No TV RSS items to process', 0, 0);
      syncProgress.complete();
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

        // Parse show name and season from title
        let { showName, season } = parseTvTitle(item.title);
        console.log(`    Parsed: Show="${showName}", Season=${season !== null ? season : 'unknown'}`);

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

        // Step 1: First try to match with Sonarr by show name (without year)
        console.log(`    Searching Sonarr for: "${showName}"`);
        let sonarrShow = findSonarrShowByName(showName);
        let enrichment: {
          tvdbId: number | null;
          tmdbId: number | null;
          imdbId: string | null;
          tvdbPosterUrl: string | null;
          tmdbPosterUrl: string | null;
        };
        
        if (sonarrShow) {
          console.log(`    ✓ Found in Sonarr: "${sonarrShow.title}" (Sonarr ID: ${sonarrShow.sonarr_id})`);
          
          // Use IDs from Sonarr
          enrichment = {
            tvdbId: sonarrShow.tvdb_id || null,
            tmdbId: sonarrShow.tmdb_id || null,
            imdbId: sonarrShow.imdb_id || null,
            tvdbPosterUrl: null, // Will extract from images if available
            tmdbPosterUrl: null, // Will extract from images if available
          };
          
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
          enrichment = await enrichTvShow(
            showName,
            season,
            tvdbApiKey,
            tmdbApiKey,
            omdbApiKey,
            braveApiKey
          );
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
        }

        // Determine status
        let status: TvReleaseStatus = 'NEW_SHOW';
        if (sonarrCheck.exists) {
          if (season !== null && !sonarrCheck.seasonExists) {
            status = 'NEW_SEASON';
            stats.newSeasons++;
          } else {
            status = 'ATTENTION_NEEDED'; // Show exists, season exists - might be a duplicate
            stats.existing++;
          }
        } else {
          stats.newShows++;
        }

        // Preserve ADDED status if it was manually added
        const finalStatus = preserveStatus ? 'ADDED' : status;

        // Create or update tv_release
        const tvRelease: Omit<TvRelease, 'id'> = {
          guid: String(item.guid || ''),
          title: String(item.title || ''),
          normalized_title: String(item.normalized_title || ''),
          show_name: showName,
          season_number: season ?? undefined,
          source_site: String(item.source_site || ''),
          feed_id: Number(item.feed_id || 0),
          link: String(item.link || ''),
          published_at: String(item.published_at || new Date().toISOString()),
          tvdb_id: enrichment.tvdbId ?? undefined,
          tmdb_id: enrichment.tmdbId ?? undefined,
          imdb_id: enrichment.imdbId ?? undefined,
          tvdb_poster_url: enrichment.tvdbPosterUrl ?? undefined,
          tmdb_poster_url: enrichment.tmdbPosterUrl ?? undefined,
          sonarr_series_id: sonarrCheck.sonarrSeriesId ?? undefined,
          sonarr_series_title: sonarrCheck.sonarrSeriesTitle ?? undefined,
          status: finalStatus,
          last_checked_at: new Date().toISOString(),
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
    syncProgress.complete();

    return stats;
  } catch (error: any) {
    console.error('[TV MATCHING ENGINE] Error:', error);
    syncProgress.error(`TV matching failed: ${error?.message || 'Unknown error'}`);
    throw error;
  }
}

