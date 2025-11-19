import Parser from 'rss-parser';
import { feedsModel } from '../models/feeds';
import { parseRSSItem } from './parseRelease';
import { releasesModel } from '../models/releases';
import { settingsModel } from '../models/settings';
import { isReleaseAllowed, computeQualityScore } from '../scoring/qualityScore';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import radarrClient from '../radarr/client';
import tmdbClient from '../tmdb/client';
import { Release } from '../types/Release';
import { QualitySettings } from '../types/QualitySettings';

const parser = new Parser();

export async function fetchAndProcessFeeds(): Promise<void> {
  const feeds = feedsModel.getEnabled();
  const settings = settingsModel.getQualitySettings();
  
  // Get TMDB API key from settings
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }

  console.log(`Fetching ${feeds.length} enabled RSS feeds...`);

  for (const feed of feeds) {
    try {
      console.log(`Fetching feed: ${feed.name} (${feed.url})`);
      const feedData = await parser.parseURL(feed.url);

      if (!feedData.items || feedData.items.length === 0) {
        console.log(`No items found in feed: ${feed.name}`);
        continue;
      }

      console.log(`Found ${feedData.items.length} items in feed: ${feed.name}`);

      let processedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      let newCount = 0;
      let ignoredCount = 0;
      let upgradeCount = 0;

      for (const item of feedData.items) {
        try {
          if (!item.title && !item.link) {
            skippedCount++;
            continue; // Skip items without title or link
          }
          
          const parsed = parseRSSItem(item as any, feed.id!, feed.name);
          
          // Check if we've already processed this item (by guid)
          const existing = releasesModel.getByGuid(parsed.guid);
          if (existing && (existing.status === 'ADDED' || existing.status === 'UPGRADED')) {
            // Skip items that have already been added or upgraded
            continue;
          }

          // Check if release is allowed
          const allowed = isReleaseAllowed(parsed.parsed, settings);
          
          let status: Release['status'] = allowed ? 'NEW' : 'IGNORED';
          
          // Try to get TMDB ID even for IGNORED releases (for better matching)
          let tmdbId = (parsed as any).tmdb_id;
          let tmdbTitle: string | undefined;
          let tmdbOriginalLanguage: string | undefined;
          
          // If we don't have a TMDB ID but have a title, try TMDB API search
          if (!tmdbId && tmdbApiKey && (parsed as any).clean_title) {
            try {
              const searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              console.log(`  Searching TMDB API for: "${searchTitle}" (${searchYear || 'no year'})`);
              const tmdbMovie = await tmdbClient.searchMovie(searchTitle, searchYear);
              if (tmdbMovie) {
                // Validate the match: check if year matches (if provided) and title similarity
                let isValidMatch = true;
                if (searchYear && tmdbMovie.release_date) {
                  const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                  if (releaseYear !== searchYear) {
                    console.log(`  TMDB search result year mismatch: expected ${searchYear}, got ${releaseYear} for "${tmdbMovie.title}"`);
                    isValidMatch = false;
                  }
                }
                
                // For very short titles (like "x & y"), be more strict about matching
                if (searchTitle.length <= 5 && tmdbMovie.title.toLowerCase() !== searchTitle.toLowerCase()) {
                  console.log(`  TMDB search result title mismatch for short query: "${searchTitle}" vs "${tmdbMovie.title}"`);
                  // Still accept it if year matches, but log the mismatch
                }
                
                if (isValidMatch) {
                  tmdbId = tmdbMovie.id;
                  tmdbTitle = tmdbMovie.title;
                  tmdbOriginalLanguage = tmdbMovie.original_language;
                  console.log(`  Found TMDB ID ${tmdbId} via API search: ${tmdbTitle}`);
                } else {
                  console.log(`  Rejected TMDB search result due to validation failure`);
                }
              }
            } catch (error) {
              console.error(`  TMDB API search error for "${(parsed as any).clean_title}":`, error);
            }
          }

          // If not allowed, save as IGNORED but still include TMDB info if we found it
          if (!allowed) {
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status,
              tmdb_id: tmdbId,
              tmdb_title: tmdbTitle,
              tmdb_original_language: tmdbOriginalLanguage,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            ignoredCount++;
            continue;
          }

          // For allowed releases, lookup in Radarr
          // First, try to use TMDB ID if we have it (from RSS or API search)
          let radarrMovie: any = null;
          let lookupResult: any = null;

          if (tmdbId) {
            // Direct lookup by TMDB ID - this is more reliable
            console.log(`  Looking up movie by TMDB ID: ${tmdbId} for: ${parsed.title}`);
            radarrMovie = await radarrClient.getMovie(tmdbId);
            if (radarrMovie && radarrMovie.id) {
              console.log(`  Found movie in Radarr by TMDB ID: ${radarrMovie.title} (ID: ${radarrMovie.id})`);
              lookupResult = {
                tmdbId: radarrMovie.tmdbId,
                title: radarrMovie.title,
                year: radarrMovie.year,
                originalLanguage: radarrMovie.originalLanguage,
              };
            } else {
              console.log(`  Movie not found in Radarr by TMDB ID: ${tmdbId}`);
            }
          }
          
          // If we still don't have TMDB ID, try TMDB API search (for allowed releases)
          if (!tmdbId && tmdbApiKey && (parsed as any).clean_title) {
            try {
              const searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              console.log(`  Searching TMDB API for: "${searchTitle}" (${searchYear || 'no year'})`);
              const tmdbMovie = await tmdbClient.searchMovie(searchTitle, searchYear);
              if (tmdbMovie) {
                // Validate the match: check if year matches (if provided) and title similarity
                let isValidMatch = true;
                if (searchYear && tmdbMovie.release_date) {
                  const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                  if (releaseYear !== searchYear) {
                    console.log(`  TMDB search result year mismatch: expected ${searchYear}, got ${releaseYear} for "${tmdbMovie.title}"`);
                    isValidMatch = false;
                  }
                }
                
                // For very short titles (like "x & y"), be more strict about matching
                if (searchTitle.length <= 5 && tmdbMovie.title.toLowerCase() !== searchTitle.toLowerCase()) {
                  console.log(`  TMDB search result title mismatch for short query: "${searchTitle}" vs "${tmdbMovie.title}"`);
                  // Still accept it if year matches, but log the mismatch
                }
                
                if (isValidMatch) {
                  tmdbId = tmdbMovie.id;
                  tmdbTitle = tmdbMovie.title;
                  tmdbOriginalLanguage = tmdbMovie.original_language;
                  console.log(`  Found TMDB ID ${tmdbId} via API search: ${tmdbTitle}`);
                  
                  // Try Radarr lookup again with the TMDB ID we just found
                  if (!radarrMovie || !radarrMovie.id) {
                    radarrMovie = await radarrClient.getMovie(tmdbId);
                    if (radarrMovie && radarrMovie.id) {
                      console.log(`  Found movie in Radarr by TMDB ID (from API): ${radarrMovie.title} (ID: ${radarrMovie.id})`);
                      lookupResult = {
                        tmdbId: radarrMovie.tmdbId,
                        title: radarrMovie.title,
                        year: radarrMovie.year,
                        originalLanguage: radarrMovie.originalLanguage,
                      };
                    }
                  }
                } else {
                  console.log(`  Rejected TMDB search result due to validation failure`);
                }
              }
            } catch (error) {
              console.error(`  TMDB API search error for "${(parsed as any).clean_title}":`, error);
            }
          }

          // If TMDB ID lookup didn't work, try searching by title
          if (!radarrMovie || !radarrMovie.id) {
            // Use clean title for searching (without quality info)
            const searchTerm = (parsed as any).clean_title || (parsed.year 
              ? `${parsed.title} ${parsed.year}` 
              : parsed.title);
            
            console.log(`  Searching Radarr for: "${searchTerm}"`);
            const lookupResults = await radarrClient.lookupMovie(searchTerm);
            
            if (lookupResults.length === 0) {
              // No movie found in Radarr - mark as NEW
              // But first, try to get TMDB ID from lookup results if available
                  const release: Omit<Release, 'id'> = {
                    ...parsed,
                    status: 'NEW',
                    tmdb_id: tmdbId || (parsed as any).tmdb_id, // Use TMDB ID from API search or RSS
                    tmdb_title: tmdbTitle,
                    tmdb_original_language: tmdbOriginalLanguage,
                    last_checked_at: new Date().toISOString(),
                  };
                  releasesModel.upsert(release);
                  newCount++;
                  processedCount++;
                  continue;
                }

            // Use first lookup result
            lookupResult = lookupResults[0];
            radarrMovie = await radarrClient.getMovie(lookupResult.tmdbId);
          }

          if (!radarrMovie || !radarrMovie.id) {
            // Movie not in Radarr - mark as NEW
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status: 'NEW',
              tmdb_id: tmdbId || lookupResult?.tmdbId,
              tmdb_title: tmdbTitle || lookupResult?.title,
              tmdb_original_language: tmdbOriginalLanguage || lookupResult?.originalLanguage?.name,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            newCount++;
            processedCount++;
            continue;
          }

          // Movie exists in Radarr - check if upgrade candidate
          // Get full movie details with history
          const movieWithHistory = await radarrClient.getMovieWithHistory(radarrMovie.id!);
          const existingFile = radarrMovie.movieFile;
          const existingSizeMb = existingFile ? existingFile.size / (1024 * 1024) : undefined;
          
          // Parse existing file attributes
          let existingParsed: any = null;
          if (existingFile) {
            existingParsed = parseReleaseFromTitle(existingFile.relativePath);
            // Also try to get info from mediaInfo if available
            if (existingFile.mediaInfo) {
              // Use MediaInfo codec if parsed codec is UNKNOWN
              if (existingFile.mediaInfo.videoCodec) {
                existingParsed.videoCodecFromMediaInfo = existingFile.mediaInfo.videoCodec;
                if (existingParsed.codec === 'UNKNOWN') {
                  // Try to map MediaInfo codec to our format
                  const upper = existingFile.mediaInfo.videoCodec.toUpperCase();
                  if (upper.includes('264') || upper.includes('AVC') || upper.includes('H.264')) {
                    existingParsed.codec = 'x264';
                  } else if (upper.includes('265') || upper.includes('HEVC') || upper.includes('H.265')) {
                    existingParsed.codec = 'x265';
                  }
                }
              }
              // Use MediaInfo audio if parsed audio is Unknown
              if (existingFile.mediaInfo.audioCodec) {
                existingParsed.audioFromMediaInfo = existingFile.mediaInfo.audioCodec;
                existingParsed.audioChannelsFromMediaInfo = existingFile.mediaInfo.audioChannels;
                if (existingParsed.audio === 'Unknown') {
                  // Map MediaInfo audio codec
                  const upper = existingFile.mediaInfo.audioCodec.toUpperCase();
                  const channels = existingFile.mediaInfo.audioChannels;
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
                    existingParsed.audio = existingFile.mediaInfo.audioCodec;
                  }
                }
              }
              if (existingFile.mediaInfo.audioLanguages) {
                existingParsed.audioLanguagesFromMediaInfo = existingFile.mediaInfo.audioLanguages;
              }
            }
          }

          // Determine if dubbed
          const originalLang = lookupResult.originalLanguage?.name || radarrMovie.originalLanguage?.name;
          const audioLangs = parsed.audio_languages ? JSON.parse(parsed.audio_languages) : [];
          const isDubbed: boolean = Boolean(originalLang && audioLangs.length > 0 && !audioLangs.includes(originalLang.toLowerCase().substring(0, 2)));

          // Check preferred language
          const preferredLanguage = audioLangs.some((lang: string) => 
            settings.preferredAudioLanguages.includes(lang)
          );

          // Compute quality scores
          const newScore = computeQualityScore(parsed.parsed, settings, {
            isDubbed,
            preferredLanguage,
          });

          // Compute existing score from existing file
          let existingScore = 0;
          if (existingFile && existingParsed) {
            // Compute score for existing file using same logic as new releases
            const existingPreferredLanguage = radarrMovie.originalLanguage && 
              settings.preferredAudioLanguages.includes(radarrMovie.originalLanguage.name.toLowerCase().substring(0, 2));
            
            existingScore = computeQualityScore(existingParsed, settings, {
              isDubbed: false, // Assume existing file is not dubbed for scoring
              preferredLanguage: existingPreferredLanguage,
            });
            
            // If parsing failed, fall back to size-based estimate
            if (existingScore === 0 && existingSizeMb) {
              existingScore = Math.min(existingSizeMb / 100, 50);
            }
          }

          const scoreDelta = newScore - existingScore;
          const sizeDeltaPercent = existingSizeMb && parsed.rss_size_mb
            ? ((parsed.rss_size_mb - existingSizeMb) / existingSizeMb) * 100
            : 0;

          // Log detailed scoring for debugging
          if (radarrMovie.id) {
            console.log(`  ${parsed.title}: existingScore=${existingScore.toFixed(2)}, newScore=${newScore.toFixed(2)}, delta=${scoreDelta.toFixed(2)}, sizeDelta=${sizeDeltaPercent.toFixed(2)}%`);
            console.log(`    Existing file: ${existingFile?.relativePath || 'none'}, size=${existingSizeMb?.toFixed(2) || 'N/A'}MB`);
            console.log(`    New release: ${parsed.parsed.resolution} ${parsed.parsed.sourceTag} ${parsed.parsed.codec} ${parsed.parsed.audio}, size=${parsed.rss_size_mb?.toFixed(2) || 'N/A'}MB`);
          }

          // Determine if upgrade candidate
          if (
            scoreDelta >= settings.upgradeThreshold &&
            sizeDeltaPercent >= settings.minSizeIncreasePercentForUpgrade
          ) {
            status = 'UPGRADE_CANDIDATE';
            upgradeCount++;
          } else {
            status = 'IGNORED';
            ignoredCount++;
            if (radarrMovie.id) {
              const reasons: string[] = [];
              if (scoreDelta < settings.upgradeThreshold) {
                reasons.push(`scoreDelta ${scoreDelta.toFixed(2)} < threshold ${settings.upgradeThreshold}`);
              }
              if (sizeDeltaPercent < settings.minSizeIncreasePercentForUpgrade) {
                reasons.push(`sizeDelta ${sizeDeltaPercent.toFixed(2)}% < threshold ${settings.minSizeIncreasePercentForUpgrade}%`);
              }
              console.log(`    → IGNORED: ${reasons.join(', ')}`);
            }
          }

          // Get last download from history
          let lastDownload: any = null;
          if (movieWithHistory?.history && movieWithHistory.history.length > 0) {
            // Find the most recent download event
            const downloadEvents = movieWithHistory.history.filter((h: any) => 
              h.eventType === 'downloadFolderImported' || 
              h.eventType === 'grabbed' ||
              h.data?.downloadUrl
            );
            if (downloadEvents.length > 0) {
              // Sort by date, most recent first
              downloadEvents.sort((a: any, b: any) => 
                new Date(b.date).getTime() - new Date(a.date).getTime()
              );
              lastDownload = downloadEvents[0];
            }
          }

          // Parse last download to get source tag if available
          let lastDownloadSourceTag = existingParsed?.sourceTag || 'OTHER';
          if (lastDownload && lastDownload.sourceTitle) {
            const lastDownloadParsed = parseReleaseFromTitle(lastDownload.sourceTitle);
            if (lastDownloadParsed.sourceTag && lastDownloadParsed.sourceTag !== 'OTHER') {
              lastDownloadSourceTag = lastDownloadParsed.sourceTag;
            }
          }

          // Store existing file attributes and history
          const existingFileAttributes = existingFile && existingParsed ? {
            path: existingFile.relativePath,
            resolution: existingParsed.resolution,
            codec: existingParsed.codec,
            sourceTag: lastDownloadSourceTag, // Use source from last download
            audio: existingParsed.audio,
            audioFromMediaInfo: existingParsed.audioFromMediaInfo,
            audioChannelsFromMediaInfo: existingParsed.audioChannelsFromMediaInfo,
            audioLanguages: existingParsed.audioLanguagesFromMediaInfo,
            videoCodec: existingParsed.videoCodecFromMediaInfo,
            sizeMb: existingSizeMb,
            lastDownload: lastDownload ? {
              sourceTitle: lastDownload.sourceTitle,
              date: lastDownload.date,
              releaseGroup: lastDownload.data?.releaseGroup,
            } : null,
          } : null;

                  const release: any = {
                    ...parsed,
                    status,
                    tmdb_id: tmdbId || lookupResult.tmdbId,
                    tmdb_title: tmdbTitle || lookupResult.title,
                    tmdb_original_language: tmdbOriginalLanguage || originalLang,
            is_dubbed: isDubbed,
            radarr_movie_id: radarrMovie.id,
            radarr_movie_title: radarrMovie.title,
            existing_size_mb: existingSizeMb,
            radarr_existing_quality_score: existingScore,
            new_quality_score: newScore,
            existing_file_path: existingFile?.relativePath || null,
            existing_file_attributes: existingFileAttributes ? JSON.stringify(existingFileAttributes) : null,
            radarr_history: movieWithHistory?.history ? JSON.stringify(movieWithHistory.history.slice(0, 10)) : null, // Store last 10 history items
            last_checked_at: new Date().toISOString(),
          };

          releasesModel.upsert(release);
          processedCount++;
        } catch (itemError) {
          errorCount++;
          console.error(`Error processing item: ${item.title || item.link || 'unknown'}`, itemError);
          // Continue processing other items even if one fails
        }
      }
      
      console.log(`Feed ${feed.name}: Processed ${processedCount}, Skipped ${skippedCount}, Errors ${errorCount}`);
      console.log(`  Status breakdown: NEW=${newCount}, UPGRADE_CANDIDATE=${upgradeCount}, IGNORED=${ignoredCount}`);
    } catch (feedError) {
      console.error(`Error fetching feed: ${feed.name}`, feedError);
    }
  }

  console.log('Finished processing all feeds');
}

