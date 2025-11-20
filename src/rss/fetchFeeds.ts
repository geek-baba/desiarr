import Parser from 'rss-parser';
import { feedsModel } from '../models/feeds';
import { parseRSSItem } from './parseRelease';
import { releasesModel } from '../models/releases';
import { settingsModel } from '../models/settings';
import { isReleaseAllowed, computeQualityScore } from '../scoring/qualityScore';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import radarrClient from '../radarr/client';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import { Release } from '../types/Release';
import { QualitySettings } from '../types/QualitySettings';
import { setRefreshStats, resetRefreshStats, getRefreshStats } from '../routes/refreshStats';

const parser = new Parser();

export async function fetchAndProcessFeeds(): Promise<void> {
  resetRefreshStats();
  const feeds = feedsModel.getEnabled();
  const settings = settingsModel.getQualitySettings();
  
  setRefreshStats({
    isRunning: true,
    startTime: new Date(),
    totalFeeds: feeds.length,
    feedsProcessed: 0,
  });
  
  // Get API keys from settings
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }
  const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
  if (omdbApiKey) {
    imdbClient.setApiKey(omdbApiKey);
  }

  console.log(`Fetching ${feeds.length} enabled RSS feeds...`);

  for (const feed of feeds) {
    try {
      setRefreshStats({
        currentFeed: feed.name,
      });
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
          // Priority: 1. Existing release with manually set TMDB ID (preserve override), 2. RSS feed TMDB ID, 3. RSS feed IMDB ID -> TMDB lookup, 4. Clean title search
          let tmdbId = existing?.tmdb_id; // Preserve manually overridden TMDB ID
          if (tmdbId && existing) {
            console.log(`  Preserving existing TMDB ID ${tmdbId} (manually overridden)`);
          } else {
            tmdbId = (parsed as any).tmdb_id; // Fall back to RSS feed TMDB ID
          }
          let tmdbTitle: string | undefined;
          let tmdbOriginalLanguage: string | undefined;
          let imdbId: string | undefined;
          let needsAttention = false;
          
          // Step 1: If RSS feed has IMDB ID but no TMDB ID, try to get TMDB ID from IMDB ID using TMDB API
          if (!tmdbId && (parsed as any).imdb_id && tmdbApiKey) {
            imdbId = (parsed as any).imdb_id;
            if (!imdbId) {
              console.log(`  IMDB ID is undefined, skipping TMDB lookup`);
            } else {
              console.log(`  Found IMDB ID ${imdbId} from RSS feed, looking up TMDB ID...`);
              try {
                const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                if (tmdbMovie) {
                  tmdbId = tmdbMovie.id;
                  tmdbTitle = tmdbMovie.title;
                  tmdbOriginalLanguage = tmdbMovie.original_language;
                  console.log(`  Found TMDB ID ${tmdbId} from IMDB ID ${imdbId}: ${tmdbTitle}`);
                } else {
                  console.log(`  TMDB ID not found for IMDB ID ${imdbId}, will mark as attention needed`);
                  needsAttention = true;
                }
              } catch (error) {
                console.error(`  Error looking up TMDB from IMDB ID ${imdbId}:`, error);
                needsAttention = true;
              }
            }
          } else if (!tmdbId && (parsed as any).imdb_id) {
            // IMDB ID found but no TMDB API key
            imdbId = (parsed as any).imdb_id;
            needsAttention = true;
            console.log(`  Found IMDB ID ${imdbId} from RSS feed but no TMDB API key configured`);
          }
          
          // Step 2: If we have TMDB ID from RSS feed, use it directly
          if (tmdbId) {
            console.log(`  Using TMDB ID ${tmdbId} from RSS feed for: ${parsed.title}`);
            try {
              const movie = await radarrClient.getMovie(tmdbId);
              if (movie) {
                tmdbTitle = movie.title;
                tmdbOriginalLanguage = movie.originalLanguage?.name;
                console.log(`  Verified TMDB ID ${tmdbId}: ${tmdbTitle}`);
              }
            } catch (error) {
              console.error(`  Error verifying TMDB ID ${tmdbId}:`, error);
            }
          }
          
          // Step 3: If we don't have a TMDB ID but have a clean title, try TMDB API search
          if (!tmdbId && tmdbApiKey && (parsed as any).clean_title) {
            try {
              // Use "clean title yyyy" format for TMDB search
              let searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              if (searchYear) {
                searchTitle = `${searchTitle} ${searchYear}`;
              }
              console.log(`  Searching TMDB API for: "${searchTitle}"`);
              const tmdbMovie = await tmdbClient.searchMovie((parsed as any).clean_title, searchYear);
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
                // Require exact title match OR year match for short titles
                if (searchTitle.length <= 10) {
                  const searchTitleLower = searchTitle.toLowerCase().trim();
                  const resultTitleLower = tmdbMovie.title.toLowerCase().trim();
                  
                  // For titles with "&" or "and", require the full phrase to match, not just substring
                  const hasAmpersand = searchTitleLower.includes('&') || searchTitleLower.includes(' and ');
                  const titleMatches = searchTitleLower === resultTitleLower;
                  
                  // If not exact match, check if it's a reasonable substring match (but not for short titles with &)
                  let isReasonableMatch = false;
                  if (!titleMatches) {
                    if (hasAmpersand) {
                      // For titles with &, require both parts to be present
                      const searchParts = searchTitleLower.split(/[&\s]+and\s+/).filter((p: string) => p.trim().length > 0);
                      if (searchParts.length >= 2) {
                        const allPartsMatch = searchParts.every((part: string) => resultTitleLower.includes(part.trim()));
                        isReasonableMatch = allPartsMatch;
                      } else {
                        // Single word with &, require exact match
                        isReasonableMatch = false;
                      }
                    } else {
                      // For titles without &, allow substring match only if it's a significant portion
                      isReasonableMatch = resultTitleLower.includes(searchTitleLower) && searchTitleLower.length >= 3;
                    }
                  }
                  
                  if (!titleMatches && !isReasonableMatch) {
                    console.log(`  TMDB search result title mismatch for short query: "${searchTitle}" vs "${tmdbMovie.title}"`);
                    // For short titles, require both year AND title similarity
                    if (!searchYear || !tmdbMovie.release_date) {
                      isValidMatch = false;
                    } else {
                      const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                      if (releaseYear !== searchYear) {
                        isValidMatch = false;
                      } else {
                        // Year matches, but title doesn't - still reject for short titles with &
                        if (hasAmpersand) {
                          isValidMatch = false;
                        }
                      }
                    }
                  }
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
          
          // If TMDB search didn't find a match, try IMDB/OMDB search, then DuckDuckGo search
          if (!tmdbId && (parsed as any).clean_title) {
            try {
              const searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              
              // First try OMDB API
              console.log(`  TMDB not found, searching IMDB/OMDB for: "${searchTitle}" (${searchYear || 'no year'})`);
              const imdbResult = await imdbClient.searchMovie(searchTitle, searchYear);
              if (imdbResult) {
                imdbId = imdbResult.imdbId;
                console.log(`  Found IMDB ID ${imdbId} via OMDB search: ${imdbResult.title} (${imdbResult.year})`);
                needsAttention = true; // Mark as attention needed since no TMDB match
              } else {
                // If OMDB didn't find it, try DuckDuckGo search as fallback
                // Use "clean title yyyy tmdb" format for web search
                let webSearchQuery = searchTitle;
                if (searchYear) {
                  webSearchQuery = `${searchTitle} ${searchYear} tmdb`;
                } else {
                  webSearchQuery = `${searchTitle} tmdb`;
                }
                console.log(`  OMDB not found, searching DuckDuckGo for IMDB ID: "${webSearchQuery}"`);
                const googleImdbId = await imdbClient.searchGoogleForImdbId(searchTitle, searchYear);
                if (googleImdbId) {
                  imdbId = googleImdbId;
                  console.log(`  Found IMDB ID ${imdbId} via Google search`);
                  needsAttention = true; // Mark as attention needed since no TMDB match
                }
              }
            } catch (error) {
              console.error(`  IMDB/OMDB/Google search error for "${(parsed as any).clean_title}":`, error);
            }
          }

          // If not allowed, still try to determine Radarr linkage so it shows as "Existing"
          if (!allowed) {
            const releaseStatus = needsAttention ? 'ATTENTION_NEEDED' : status;
            let ignoredRadarrMovie: any = null;

            if (tmdbId) {
              try {
                console.log(`  (IGNORED) Checking Radarr for TMDB ID ${tmdbId} to mark as existing`);
                ignoredRadarrMovie = await radarrClient.getMovie(tmdbId);
                if (ignoredRadarrMovie && ignoredRadarrMovie.id) {
                  console.log(`  (IGNORED) Found movie in Radarr: ${ignoredRadarrMovie.title} (ID: ${ignoredRadarrMovie.id})`);
                }
              } catch (error) {
                console.error(`  Radarr lookup error for ignored release (TMDB ${tmdbId}):`, error);
              }
            }

            const release: any = {
              ...parsed,
              status: releaseStatus,
              tmdb_id: tmdbId,
              tmdb_title: tmdbTitle,
              tmdb_original_language: tmdbOriginalLanguage,
              imdb_id: imdbId,
              radarr_movie_id: ignoredRadarrMovie?.id || null,
              radarr_movie_title: ignoredRadarrMovie?.title || null,
              existing_size_mb: ignoredRadarrMovie?.movieFile ? ignoredRadarrMovie.movieFile.size / (1024 * 1024) : undefined,
              existing_file_path: ignoredRadarrMovie?.movieFile?.relativePath || null,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            if (needsAttention) {
              console.log(`  Marked as ATTENTION_NEEDED (IMDB ID found but no TMDB match)`);
            }
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
              // Use "clean title yyyy" format for TMDB search
              let searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              if (searchYear) {
                searchTitle = `${searchTitle} ${searchYear}`;
              }
              console.log(`  Searching TMDB API for: "${searchTitle}"`);
              const tmdbMovie = await tmdbClient.searchMovie((parsed as any).clean_title, searchYear);
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
                // Require exact title match OR year match for short titles
                if (searchTitle.length <= 10) {
                  const searchTitleLower = searchTitle.toLowerCase().trim();
                  const resultTitleLower = tmdbMovie.title.toLowerCase().trim();
                  
                  // For titles with "&" or "and", require the full phrase to match, not just substring
                  const hasAmpersand = searchTitleLower.includes('&') || searchTitleLower.includes(' and ');
                  const titleMatches = searchTitleLower === resultTitleLower;
                  
                  // If not exact match, check if it's a reasonable substring match (but not for short titles with &)
                  let isReasonableMatch = false;
                  if (!titleMatches) {
                    if (hasAmpersand) {
                      // For titles with &, require both parts to be present
                      const searchParts = searchTitleLower.split(/[&\s]+and\s+/).filter((p: string) => p.trim().length > 0);
                      if (searchParts.length >= 2) {
                        const allPartsMatch = searchParts.every((part: string) => resultTitleLower.includes(part.trim()));
                        isReasonableMatch = allPartsMatch;
                      } else {
                        // Single word with &, require exact match
                        isReasonableMatch = false;
                      }
                    } else {
                      // For titles without &, allow substring match only if it's a significant portion
                      isReasonableMatch = resultTitleLower.includes(searchTitleLower) && searchTitleLower.length >= 3;
                    }
                  }
                  
                  if (!titleMatches && !isReasonableMatch) {
                    console.log(`  TMDB search result title mismatch for short query: "${searchTitle}" vs "${tmdbMovie.title}"`);
                    // For short titles, require both year AND title similarity
                    if (!searchYear || !tmdbMovie.release_date) {
                      isValidMatch = false;
                    } else {
                      const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                      if (releaseYear !== searchYear) {
                        isValidMatch = false;
                      } else {
                        // Year matches, but title doesn't - still reject for short titles with &
                        if (hasAmpersand) {
                          isValidMatch = false;
                        }
                      }
                    }
                  }
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
          
          // If TMDB search still didn't find a match, try IMDB/OMDB search, then DuckDuckGo search (for allowed releases)
          if (!tmdbId && (parsed as any).clean_title) {
            try {
              const searchTitle = (parsed as any).clean_title;
              const searchYear = parsed.year;
              
              // First try OMDB API
              console.log(`  TMDB not found, searching IMDB/OMDB for: "${searchTitle}" (${searchYear || 'no year'})`);
              let omdbSucceeded = false;
              try {
                const imdbResult = await imdbClient.searchMovie(searchTitle, searchYear);
                if (imdbResult) {
                  imdbId = imdbResult.imdbId;
                  console.log(`  Found IMDB ID ${imdbId} via OMDB search: ${imdbResult.title} (${imdbResult.year})`);
                  needsAttention = true; // Mark as attention needed since no TMDB match
                  omdbSucceeded = true;
                }
              } catch (omdbError: any) {
                // OMDB might fail due to API key or rate limits - continue to DuckDuckGo
                console.log(`  OMDB search failed or returned no results: ${omdbError?.message || 'Unknown error'}`);
              }
              
              // If OMDB didn't find it or failed, try DuckDuckGo search as fallback
              if (!omdbSucceeded && !imdbId) {
                // Use "clean title yyyy tmdb" format for web search
                let webSearchQuery = searchTitle;
                if (searchYear) {
                  webSearchQuery = `${searchTitle} ${searchYear} tmdb`;
                } else {
                  webSearchQuery = `${searchTitle} tmdb`;
                }
                console.log(`  OMDB not found/failed, searching DuckDuckGo for IMDB ID: "${webSearchQuery}"`);
                try {
                  const googleImdbId = await imdbClient.searchGoogleForImdbId(searchTitle, searchYear);
                  if (googleImdbId) {
                    imdbId = googleImdbId;
                    console.log(`  Found IMDB ID ${imdbId} via DuckDuckGo search`);
                    needsAttention = true; // Mark as attention needed since no TMDB match
                  } else {
                    console.log(`  DuckDuckGo search did not find IMDB ID`);
                  }
                } catch (ddgError) {
                  console.error(`  DuckDuckGo search error:`, ddgError);
                }
              }
            } catch (error) {
              console.error(`  IMDB/OMDB/Google search error for "${(parsed as any).clean_title}":`, error);
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
              // No movie found in Radarr - mark as NEW or ATTENTION_NEEDED
              const releaseStatus = needsAttention ? 'ATTENTION_NEEDED' : 'NEW';
              const release: Omit<Release, 'id'> = {
                ...parsed,
                status: releaseStatus,
                tmdb_id: tmdbId || (parsed as any).tmdb_id, // Use TMDB ID from API search or RSS
                tmdb_title: tmdbTitle,
                tmdb_original_language: tmdbOriginalLanguage,
                imdb_id: imdbId || (parsed as any).imdb_id, // Preserve IMDB ID from RSS or web search
                last_checked_at: new Date().toISOString(),
              };
              releasesModel.upsert(release);
              if (needsAttention) {
                console.log(`  Marked as ATTENTION_NEEDED (IMDB ID found but no TMDB match)`);
              }
              newCount++;
              processedCount++;
              continue;
            }

            // Use first lookup result
            lookupResult = lookupResults[0];
            radarrMovie = await radarrClient.getMovie(lookupResult.tmdbId);
          }

          if (!radarrMovie || !radarrMovie.id) {
            // Movie not in Radarr - mark as NEW or ATTENTION_NEEDED
            const releaseStatus = needsAttention ? 'ATTENTION_NEEDED' : 'NEW';
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status: releaseStatus,
              tmdb_id: tmdbId || lookupResult?.tmdbId,
              tmdb_title: tmdbTitle || lookupResult?.title,
              tmdb_original_language: tmdbOriginalLanguage || lookupResult?.originalLanguage?.name,
              imdb_id: imdbId,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            if (needsAttention) {
              console.log(`  Marked as ATTENTION_NEEDED (IMDB ID found but no TMDB match)`);
            }
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
          let finalStatus: Release['status'] = status;
          if (
            scoreDelta >= settings.upgradeThreshold &&
            sizeDeltaPercent >= settings.minSizeIncreasePercentForUpgrade
          ) {
            finalStatus = 'UPGRADE_CANDIDATE';
            upgradeCount++;
          } else {
            finalStatus = needsAttention ? 'ATTENTION_NEEDED' : 'IGNORED';
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
                    status: finalStatus,
                    tmdb_id: tmdbId || lookupResult.tmdbId,
                    tmdb_title: tmdbTitle || lookupResult.title,
                    tmdb_original_language: tmdbOriginalLanguage || originalLang,
                    imdb_id: imdbId || (parsed as any).imdb_id, // Preserve IMDB ID from RSS or web search
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
              
              const currentStats = getRefreshStats();
              setRefreshStats({
                feedsProcessed: currentStats.feedsProcessed + 1,
                itemsProcessed: currentStats.itemsProcessed + processedCount,
                newCount: currentStats.newCount + newCount,
                upgradeCount: currentStats.upgradeCount + upgradeCount,
                ignoredCount: currentStats.ignoredCount + ignoredCount,
                errorCount: currentStats.errorCount + errorCount,
              });
            } catch (feedError) {
              console.error(`Error fetching feed: ${feed.name}`, feedError);
              const currentStats = getRefreshStats();
              setRefreshStats({
                feedsProcessed: currentStats.feedsProcessed + 1,
                errorCount: currentStats.errorCount + 1,
              });
            }
          }

          console.log('Finished processing all feeds');
          setRefreshStats({
            isRunning: false,
            currentFeed: undefined,
          });
        }

