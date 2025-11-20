import db from '../db';
import { releasesModel } from '../models/releases';
import { settingsModel } from '../models/settings';
import { isReleaseAllowed, computeQualityScore } from '../scoring/qualityScore';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
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

    // Get all synced RSS items
    const rssItems = getSyncedRssItems();
    stats.totalRssItems = rssItems.length;

    console.log(`Processing ${rssItems.length} synced RSS items...`);

    for (const item of rssItems) {
      try {
        // Check if we've already processed this item (by guid)
        const existingRelease = releasesModel.getByGuid(item.guid);
        if (existingRelease && (existingRelease.status === 'ADDED' || existingRelease.status === 'UPGRADED')) {
          // Skip items that have already been added or upgraded
          continue;
        }

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

        // Step 1: If RSS feed has IMDB ID but no TMDB ID, try to get TMDB ID from IMDB ID
        if (!tmdbId && imdbId && tmdbApiKey) {
          try {
            const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
            if (tmdbMovie) {
              tmdbId = tmdbMovie.id;
              tmdbTitle = tmdbMovie.title;
              tmdbOriginalLanguage = tmdbMovie.original_language;
            } else {
              needsAttention = true;
            }
          } catch (error) {
            needsAttention = true;
          }
        } else if (!tmdbId && imdbId) {
          needsAttention = true;
        }

        // Step 2: If we have TMDB ID, look up in synced Radarr movies
        if (tmdbId) {
          const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
          if (syncedRadarrMovie) {
            radarrMovieId = syncedRadarrMovie.radarr_id;
            radarrMovieTitle = syncedRadarrMovie.title;
            tmdbTitle = syncedRadarrMovie.title;
            tmdbOriginalLanguage = syncedRadarrMovie.original_language;

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
              } catch (error) {
                console.error(`Error parsing movie file for ${syncedRadarrMovie.title}:`, error);
              }
            }
          }
        }

        // Step 3: If we don't have TMDB ID but have a clean title, try TMDB API search
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

                // Check synced Radarr again with new TMDB ID
                if (tmdbId) {
                  const syncedRadarrMovie = getSyncedRadarrMovieByTmdbId(tmdbId);
                  if (syncedRadarrMovie) {
                    radarrMovieId = syncedRadarrMovie.radarr_id;
                    radarrMovieTitle = syncedRadarrMovie.title;
                  }
                }
              }
            }
          } catch (error) {
            console.error(`TMDB search error for "${item.clean_title}":`, error);
          }
        }

        // Step 4: If still no TMDB ID, try IMDB/OMDB search
        if (!tmdbId && item.clean_title) {
          try {
            const imdbResult = await imdbClient.searchMovie(item.clean_title, item.year || undefined);
            if (imdbResult) {
              imdbId = imdbResult.imdbId;
              needsAttention = true;
            }
          } catch (error) {
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
            } catch (error) {
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

        // Create or update release
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
          status,
          last_checked_at: new Date().toISOString(),
        };

        releasesModel.upsert(release);
        stats.processed++;
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

