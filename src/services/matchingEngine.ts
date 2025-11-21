import db from '../db';
import { releasesModel } from '../models/releases';
import { settingsModel } from '../models/settings';
import { isReleaseAllowed, computeQualityScore } from '../scoring/qualityScore';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import radarrClient from '../radarr/client';
import { Release } from '../types/Release';
import { getSyncedRadarrMovieByTmdbId, getSyncedRadarrMovieByRadarrId } from './radarrSync';
import { getSyncedRssItems } from './rssSync';

export interface MatchingStats {
  totalRssItems: number;
  processed: number;
  newReleases: number;
  upgradeCandidates: number;
  existing: number;
  ignored: number;
  errors: number;
}

/**
 * Run matching engine after syncs are complete
 * This processes synced RSS items and creates/updates releases
 */
export async function runMatchingEngine(): Promise<MatchingStats> {
  const stats: MatchingStats = {
    totalRssItems: 0,
    processed: 0,
    newReleases: 0,
    upgradeCandidates: 0,
    existing: 0,
    ignored: 0,
    errors: 0,
  };

  try {
    console.log('Starting matching engine...');
    const settings = settingsModel.getQualitySettings();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;

    if (tmdbApiKey) {
      tmdbClient.setApiKey(tmdbApiKey);
    }
    if (omdbApiKey) {
      imdbClient.setApiKey(omdbApiKey);
    }
    
    // Initialize Radarr client for history fetching
    radarrClient.updateConfig();

    // Get all synced RSS items
    const rssItems = getSyncedRssItems();
    stats.totalRssItems = rssItems.length;

    console.log(`[MATCHING ENGINE] Processing ${rssItems.length} synced RSS items...`);
    
    // Log sample of items being processed
    if (rssItems.length > 0) {
      console.log(`[MATCHING ENGINE] Sample items: ${rssItems.slice(0, 5).map(i => `"${i.title}" (TMDB: ${i.tmdb_id || 'none'})`).join(', ')}`);
      
      // Check if Chocolate is in the list
      const chocolateItems = rssItems.filter(i => i.title && i.title.toLowerCase().includes('chocolate'));
      if (chocolateItems.length > 0) {
        console.log(`[MATCHING ENGINE] Found ${chocolateItems.length} item(s) with "Chocolate" in title:`, chocolateItems.map(i => `"${i.title}" (ID: ${i.id}, TMDB: ${i.tmdb_id || 'none'})`).join(', '));
      } else {
        console.log(`[MATCHING ENGINE] No items found with "Chocolate" in title. Total items: ${rssItems.length}`);
      }
    } else {
      console.log(`[MATCHING ENGINE] WARNING: No RSS items found to process!`);
    }

    for (const item of rssItems) {
      try {
        console.log(`\n[MATCHING ENGINE] Processing RSS item: "${item.title}" (TMDB: ${item.tmdb_id || 'none'}, IMDB: ${item.imdb_id || 'none'})`);
        
        // Check if we've already processed this item (by guid)
        const existingRelease = releasesModel.getByGuid(item.guid);
        // Note: We still process items with ADDED/UPGRADED status to update metadata
        // but we preserve their status at the end
        const preserveStatus = existingRelease && (existingRelease.status === 'ADDED' || existingRelease.status === 'UPGRADED');

        // Check if release is allowed
        const parsed = {
          resolution: item.resolution,
          sourceTag: item.source_tag,
          codec: item.codec,
          audio: item.audio,
          sizeMb: item.rss_size_mb,
        };
        const allowed = isReleaseAllowed(parsed, settings);

        let status: Release['status'] = allowed ? 'NEW' : 'IGNORED';
        let tmdbId = item.tmdb_id;
        let tmdbTitle: string | undefined;
        let tmdbOriginalLanguage: string | undefined;
        let imdbId: string | undefined = item.imdb_id;
        let needsAttention = false;
        let radarrMovieId: number | undefined;
        let radarrMovieTitle: string | undefined;
        let existingSizeMb: number | undefined;
        let existingFilePath: string | undefined;
        let existingFileAttributes: string | undefined;
        let radarrHistory: string | undefined;

        // Step 0: Validate existing TMDB/IMDB ID pair if both are present
        if (tmdbId && imdbId && tmdbApiKey) {
          try {
            console.log(`  Validating TMDB ID ${tmdbId} and IMDB ID ${imdbId} match...`);
            const tmdbMovie = await tmdbClient.getMovie(tmdbId);
            const tmdbImdbId = tmdbMovie?.imdb_id;
            
            if (tmdbImdbId && tmdbImdbId !== imdbId) {
              console.log(`  ⚠ MISMATCH DETECTED: TMDB ${tmdbId} has IMDB ${tmdbImdbId}, but we have IMDB ${imdbId}`);
              console.log(`  TMDB movie: "${tmdbMovie?.title}" (${tmdbMovie?.release_date ? new Date(tmdbMovie.release_date).getFullYear() : 'unknown'})`);
              
              // Try to get TMDB ID from the IMDB ID we have
              try {
                const correctTmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                if (correctTmdbMovie) {
                  const correctTmdbId = correctTmdbMovie.id;
                  const correctYear = correctTmdbMovie.release_date ? new Date(correctTmdbMovie.release_date).getFullYear() : null;
                  console.log(`  ✓ Found TMDB ID ${correctTmdbId} for IMDB ${imdbId}: "${correctTmdbMovie.title}" (${correctYear || 'unknown'})`);
                  
                  // Validate year match if we have a year
                  if (item.year && correctYear && correctYear === item.year) {
                    console.log(`  ✓ Year matches (${item.year}) - using correct TMDB ID ${correctTmdbId}`);
                    tmdbId = correctTmdbId;
                  } else if (!item.year || !correctYear) {
                    // If we don't have year info, trust the IMDB match
                    console.log(`  ⚠ No year validation possible - using TMDB ID ${correctTmdbId} from IMDB ${imdbId}`);
                    tmdbId = correctTmdbId;
                  } else {
                    console.log(`  ⚠ Year mismatch: expected ${item.year}, got ${correctYear} - keeping original TMDB ID ${tmdbId}`);
                  }
                } else {
                  console.log(`  ⚠ Could not find TMDB ID for IMDB ${imdbId} - keeping original TMDB ID ${tmdbId}`);
                }
              } catch (error: any) {
                console.log(`  ⚠ Failed to validate IMDB ${imdbId} - keeping original TMDB ID ${tmdbId}`);
              }
            } else if (tmdbImdbId === imdbId) {
              console.log(`  ✓ TMDB ${tmdbId} and IMDB ${imdbId} match correctly`);
            } else if (!tmdbImdbId) {
              console.log(`  ⚠ TMDB ${tmdbId} has no IMDB ID - cannot validate match`);
            }
            
            // After validation/correction, check Radarr again with the (possibly corrected) TMDB ID
            if (tmdbId) {
              const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
              if (syncedRadarrMovie) {
                radarrMovieId = syncedRadarrMovie.radarr_id;
                radarrMovieTitle = syncedRadarrMovie.title;
                console.log(`  ✓ Found Radarr movie match after IMDB validation: TMDB ID ${tmdbId} -> Radarr ID ${radarrMovieId} (${radarrMovieTitle})`);
              } else {
                console.log(`  ✗ No Radarr movie found for TMDB ID ${tmdbId} after IMDB validation (${item.title})`);
              }
            }
          } catch (error: any) {
            console.log(`  ⚠ Failed to validate TMDB/IMDB pair:`, error);
          }
        }

        // Step 1: TMDB ID is PRIMARY - if we have TMDB ID, extract IMDB ID from TMDB
        if (tmdbId && tmdbApiKey && !imdbId) {
          try {
            const tmdbMovie = await tmdbClient.getMovie(tmdbId);
            if (tmdbMovie && tmdbMovie.imdb_id) {
              imdbId = tmdbMovie.imdb_id;
              tmdbTitle = tmdbMovie.title;
              tmdbOriginalLanguage = tmdbMovie.original_language;
            }
          } catch (error: any) {
            // Ignore - we still have TMDB ID which is what matters
          }
        }

        // Step 1b: If we have IMDB ID but no TMDB ID, try to get TMDB ID from IMDB ID (secondary path)
        // Note: This is less ideal since Radarr requires TMDB ID
        if (!tmdbId && imdbId && tmdbApiKey) {
          try {
            const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
            if (tmdbMovie) {
              tmdbId = tmdbMovie.id;
              tmdbTitle = tmdbMovie.title;
              tmdbOriginalLanguage = tmdbMovie.original_language;
              
              // Check synced Radarr with new TMDB ID
              const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
              if (syncedRadarrMovie) {
                radarrMovieId = syncedRadarrMovie.radarr_id;
                radarrMovieTitle = syncedRadarrMovie.title;
                console.log(`  ✓ Found Radarr movie match after IMDB->TMDB lookup (Step 1b): TMDB ID ${tmdbId} -> Radarr ID ${radarrMovieId} (${radarrMovieTitle})`);
              } else {
                console.log(`  ✗ No Radarr movie found for TMDB ID ${tmdbId} after IMDB->TMDB lookup (Step 1b) (${item.title})`);
              }
            } else {
              needsAttention = true; // Have IMDB but no TMDB - won't work with Radarr
            }
          } catch (error: any) {
            needsAttention = true;
          }
        } else if (!tmdbId && imdbId) {
          needsAttention = true; // Have IMDB but no TMDB and no API key
        }

        // Step 2: If we have TMDB ID, look up in synced Radarr movies
        if (tmdbId) {
          const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
          if (syncedRadarrMovie) {
            radarrMovieId = syncedRadarrMovie.radarr_id;
            radarrMovieTitle = syncedRadarrMovie.title;
            tmdbTitle = syncedRadarrMovie.title;
            tmdbOriginalLanguage = syncedRadarrMovie.original_language;
            console.log(`  ✓ Found Radarr movie match: TMDB ID ${tmdbId} -> Radarr ID ${radarrMovieId} (${radarrMovieTitle})`);

            // Fetch Radarr history for this movie to get last download
            if (radarrMovieId) {
              try {
                const history = await radarrClient.getMovieHistory(radarrMovieId);
                if (history && history.length > 0) {
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
                    radarrHistory = JSON.stringify(downloadEvents);
                  }
                }
              } catch (error: any) {
                console.log(`Could not fetch history for Radarr movie ${radarrMovieId}:`, error);
              }
            }

            // Parse movie file if available
            if (syncedRadarrMovie.movie_file) {
              try {
                const movieFile = JSON.parse(syncedRadarrMovie.movie_file);
                existingSizeMb = movieFile.size ? movieFile.size / (1024 * 1024) : undefined;
                existingFilePath = movieFile.relativePath || undefined;

                // Parse existing file attributes
                if (movieFile.relativePath) {
                  const existingParsed: any = parseReleaseFromTitle(movieFile.relativePath);
                  
                  // Enhance with MediaInfo if available
                  if (movieFile.mediaInfo) {
                    if (movieFile.mediaInfo.videoCodec) {
                      existingParsed.videoCodecFromMediaInfo = movieFile.mediaInfo.videoCodec;
                      if (existingParsed.codec === 'UNKNOWN') {
                        const upper = movieFile.mediaInfo.videoCodec.toUpperCase();
                        if (upper.includes('264') || upper.includes('AVC') || upper.includes('H.264')) {
                          existingParsed.codec = 'x264';
                        } else if (upper.includes('265') || upper.includes('HEVC') || upper.includes('H.265')) {
                          existingParsed.codec = 'x265';
                        }
                      }
                    }
                    if (movieFile.mediaInfo.audioCodec) {
                      existingParsed.audioFromMediaInfo = movieFile.mediaInfo.audioCodec;
                      existingParsed.audioChannelsFromMediaInfo = movieFile.mediaInfo.audioChannels;
                      if (existingParsed.audio === 'Unknown') {
                        const upper = movieFile.mediaInfo.audioCodec.toUpperCase();
                        const channels = movieFile.mediaInfo.audioChannels;
                        if (upper.includes('EAC3') || upper.includes('E-AC-3') || upper.includes('DDP')) {
                          if (channels === 2) existingParsed.audio = 'DDP 2.0';
                          else if (channels === 6) existingParsed.audio = 'DDP 5.1';
                          else if (channels === 8) existingParsed.audio = 'DDP 7.1';
                          else existingParsed.audio = 'DDP';
                        } else if (upper.includes('AC3') || upper.includes('AC-3')) {
                          if (channels === 2) existingParsed.audio = 'DD 2.0';
                          else if (channels === 6) existingParsed.audio = 'DD 5.1';
                          else existingParsed.audio = 'DD';
                        } else if (upper.includes('TRUEHD')) {
                          existingParsed.audio = 'TrueHD';
                        } else if (upper.includes('ATMOS')) {
                          existingParsed.audio = 'Atmos';
                        } else if (upper.includes('AAC')) {
                          if (channels === 2) existingParsed.audio = 'AAC 2.0';
                          else if (channels === 6) existingParsed.audio = 'AAC 5.1';
                          else existingParsed.audio = 'AAC';
                        } else {
                          existingParsed.audio = movieFile.mediaInfo.audioCodec;
                        }
                      }
                    }
                    if (movieFile.mediaInfo.audioLanguages) {
                      existingParsed.audioLanguagesFromMediaInfo = movieFile.mediaInfo.audioLanguages;
                    }
                  }

                  existingFileAttributes = JSON.stringify({
                    path: movieFile.relativePath,
                    resolution: existingParsed.resolution,
                    codec: existingParsed.codec,
                    sourceTag: existingParsed.sourceTag || 'OTHER',
                    audio: existingParsed.audio,
                    audioFromMediaInfo: existingParsed.audioFromMediaInfo,
                    audioChannelsFromMediaInfo: existingParsed.audioChannelsFromMediaInfo,
                    audioLanguages: existingParsed.audioLanguagesFromMediaInfo,
                    videoCodec: existingParsed.videoCodecFromMediaInfo,
                    sizeMb: existingSizeMb,
                  });
                }
              } catch (error: any) {
                console.error(`Error parsing movie file for ${syncedRadarrMovie.title}:`, error);
              }
            }
          } else {
            console.log(`  ✗ No Radarr movie found for TMDB ID ${tmdbId} (${item.title})`);
          }
        }

        // Step 2: If we don't have TMDB ID but have a clean title, try TMDB API search FIRST (primary)
        if (!tmdbId && tmdbApiKey && item.clean_title) {
          try {
            const tmdbMovie = await tmdbClient.searchMovie(item.clean_title, item.year || undefined);
            if (tmdbMovie) {
              // Validate match
              let isValidMatch = true;
              if (item.year && tmdbMovie.release_date) {
                const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                if (releaseYear !== item.year) {
                  isValidMatch = false;
                }
              }

              if (isValidMatch) {
                tmdbId = tmdbMovie.id;
                tmdbTitle = tmdbMovie.title;
                tmdbOriginalLanguage = tmdbMovie.original_language;

                // Extract IMDB ID from TMDB movie (primary source)
                if (!imdbId && tmdbMovie.imdb_id) {
                  imdbId = tmdbMovie.imdb_id;
                }

                // Check synced Radarr again with new TMDB ID
                if (tmdbId) {
                  const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
                  if (syncedRadarrMovie) {
                    radarrMovieId = syncedRadarrMovie.radarr_id;
                    radarrMovieTitle = syncedRadarrMovie.title;
                    console.log(`  ✓ Found Radarr movie match after TMDB search: TMDB ID ${tmdbId} -> Radarr ID ${radarrMovieId} (${radarrMovieTitle})`);
                  } else {
                    console.log(`  ✗ No Radarr movie found for TMDB ID ${tmdbId} after TMDB search (${item.title})`);
                  }
                }
              }
            }
          } catch (error: any) {
            console.error(`TMDB search error for "${item.clean_title}":`, error);
          }
        }

        // Step 3: If still no TMDB ID, try IMDB/OMDB search as last resort
        // (Note: If we find IMDB but not TMDB, movie won't work with Radarr)
        if (!tmdbId && item.clean_title) {
          try {
            const imdbResult = await imdbClient.searchMovie(item.clean_title, item.year || undefined);
            if (imdbResult) {
              imdbId = imdbResult.imdbId;
              // Try to get TMDB ID from IMDB ID
              if (tmdbApiKey) {
                try {
                  const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                  if (tmdbMovie) {
                    tmdbId = tmdbMovie.id;
                    tmdbTitle = tmdbMovie.title;
                    tmdbOriginalLanguage = tmdbMovie.original_language;
                    
                    // Check synced Radarr again with new TMDB ID
                    const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
                    if (syncedRadarrMovie) {
                      radarrMovieId = syncedRadarrMovie.radarr_id;
                      radarrMovieTitle = syncedRadarrMovie.title;
                      console.log(`  ✓ Found Radarr movie match after IMDB->TMDB lookup: TMDB ID ${tmdbId} -> Radarr ID ${radarrMovieId} (${radarrMovieTitle})`);
                    } else {
                      console.log(`  ✗ No Radarr movie found for TMDB ID ${tmdbId} after IMDB->TMDB lookup (${item.title})`);
                    }
                  } else {
                    needsAttention = true; // Have IMDB but no TMDB
                  }
                } catch (error: any) {
                  needsAttention = true;
                }
              } else {
                needsAttention = true; // Have IMDB but no TMDB and no API key
              }
            }
          } catch (error: any) {
            // Continue
          }
        }

        // For allowed releases, compute quality scores and determine status
        if (allowed && radarrMovieId) {
          const newScore = computeQualityScore(parsed, settings, {
            isDubbed: false,
            preferredLanguage: false,
          });

          let existingScore = 0;
          if (existingFileAttributes) {
            try {
              const attrs = JSON.parse(existingFileAttributes);
              const existingParsed = {
                resolution: attrs.resolution,
                sourceTag: attrs.sourceTag,
                codec: attrs.codec,
                audio: attrs.audio,
                sizeMb: attrs.sizeMb,
              };
              existingScore = computeQualityScore(existingParsed, settings, {
                isDubbed: false,
                preferredLanguage: false,
              });
            } catch (error: any) {
              // Ignore
            }
          }

          const scoreDelta = newScore - existingScore;
          const sizeDeltaPercent = existingSizeMb && item.rss_size_mb
            ? ((item.rss_size_mb - existingSizeMb) / existingSizeMb) * 100
            : 0;

          if (
            scoreDelta >= settings.upgradeThreshold &&
            sizeDeltaPercent >= settings.minSizeIncreasePercentForUpgrade
          ) {
            status = 'UPGRADE_CANDIDATE';
            stats.upgradeCandidates++;
          } else {
            // Movie exists in Radarr but not an upgrade candidate - mark as IGNORED
            // The dashboard will still show it as "existing" based on radarr_movie_id
            status = 'IGNORED';
            stats.existing++;
          }
        } else if (allowed) {
          status = needsAttention ? 'ATTENTION_NEEDED' : 'NEW';
          stats.newReleases++;
        } else {
          if (radarrMovieId) {
            // Movie exists in Radarr but quality doesn't meet requirements - mark as IGNORED
            // The dashboard will still show it as "existing" based on radarr_movie_id
            status = 'IGNORED';
            stats.existing++;
          } else {
            status = needsAttention ? 'ATTENTION_NEEDED' : 'IGNORED';
            stats.ignored++;
          }
        }

        // Create or update release - ALWAYS create/update, even if IGNORED
        // This ensures all RSS items appear in the dashboard
        // Preserve ADDED/UPGRADED status if item was already processed
        const finalStatus = preserveStatus ? existingRelease!.status : status;
        
        const release: any = {
          guid: item.guid,
          title: item.title,
          normalized_title: item.normalized_title,
          year: item.year,
          source_site: item.source_site,
          feed_id: item.feed_id,
          link: item.link,
          resolution: item.resolution,
          source_tag: item.source_tag,
          codec: item.codec,
          audio: item.audio,
          rss_size_mb: item.rss_size_mb,
          existing_size_mb: existingSizeMb,
          published_at: item.published_at,
          tmdb_id: tmdbId,
          tmdb_title: tmdbTitle,
          tmdb_original_language: tmdbOriginalLanguage,
          imdb_id: imdbId,
          radarr_movie_id: radarrMovieId,
          radarr_movie_title: radarrMovieTitle,
          existing_file_path: existingFilePath,
          existing_file_attributes: existingFileAttributes,
          radarr_history: radarrHistory,
          status: finalStatus,
          last_checked_at: new Date().toISOString(),
        };

        releasesModel.upsert(release);
        stats.processed++;
        
        // Update stats based on final status
        if (status === 'NEW' || status === 'ATTENTION_NEEDED') {
          stats.newReleases++;
        } else if (status === 'UPGRADE_CANDIDATE') {
          stats.upgradeCandidates++;
        } else if (status === 'IGNORED') {
          stats.ignored++;
        } else if (radarrMovieId) {
          stats.existing++;
        }
      } catch (error: any) {
        stats.errors++;
        console.error(`Error processing RSS item ${item.guid}:`, error);
      }
    }

    console.log(`Matching engine completed: ${stats.processed} processed, ${stats.newReleases} new, ${stats.upgradeCandidates} upgrades, ${stats.existing} existing, ${stats.ignored} ignored, ${stats.errors} errors`);
    return stats;
  } catch (error: any) {
    console.error('Matching engine error:', error);
    throw error;
  }
}

