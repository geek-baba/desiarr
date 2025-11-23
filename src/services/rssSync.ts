import Parser from 'rss-parser';
import db from '../db';
import { feedsModel } from '../models/feeds';
import { parseRSSItem } from '../rss/parseRelease';
import tmdbClient from '../tmdb/client';
import imdbClient from '../imdb/client';
import braveClient from '../brave/client';
import { settingsModel } from '../models/settings';
import { syncProgress } from './syncProgress';

const parser = new Parser();

export interface RssSyncStats {
  totalFeeds: number;
  feedsProcessed: number;
  totalItems: number;
  itemsSynced: number;
  itemsUpdated: number;
  errors: Array<{ feedId: number; feedName: string; error: string }>;
  lastSyncAt: Date;
}

/**
 * Sync all RSS feeds and store items in rss_feed_items table
 */
export async function syncRssFeeds(): Promise<RssSyncStats> {
  const stats: RssSyncStats = {
    totalFeeds: 0,
    feedsProcessed: 0,
    totalItems: 0,
    itemsSynced: 0,
    itemsUpdated: 0,
    errors: [],
    lastSyncAt: new Date(),
  };

  // Track if Brave search is rate limited to skip it for remaining items
  let braveRateLimited = false;

  try {
    console.log('Starting RSS feeds sync...');
    syncProgress.start('rss', 0);
    syncProgress.update('Initializing...', 0);
    
    // Get API keys for TMDB/OMDB/Brave lookups
    const allSettings = settingsModel.getAll();
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
    
    const feeds = feedsModel.getEnabled();
    stats.totalFeeds = feeds.length;

    console.log(`Found ${feeds.length} enabled RSS feeds`);
    syncProgress.update(`Found ${feeds.length} enabled RSS feeds`, 0, feeds.length);

    for (let feedIndex = 0; feedIndex < feeds.length; feedIndex++) {
      const feed = feeds[feedIndex];
      try {
        console.log(`Syncing feed: ${feed.name} (${feed.url})`);
        syncProgress.update(`Syncing feed: ${feed.name}...`, feedIndex, feeds.length);
        const feedData = await parser.parseURL(feed.url);

        if (!feedData.items || feedData.items.length === 0) {
          console.log(`No items found in feed: ${feed.name}`);
          stats.feedsProcessed++;
          syncProgress.update(`Completed ${feed.name} (0 items)`, feedIndex + 1, feeds.length, stats.errors.length);
          continue;
        }

        console.log(`Found ${feedData.items.length} items in feed: ${feed.name}`);
        stats.totalItems += feedData.items.length;

        // Process items and enrich with TMDB/IMDB IDs
        const enrichedItems: Array<{ parsed: any; tmdbId: number | null; imdbId: string | null; originalItem: any; guid: string }> = [];
        for (let itemIndex = 0; itemIndex < feedData.items.length; itemIndex++) {
          const item = feedData.items[itemIndex];
          
          // Update progress every 5 items or at the start
          if (itemIndex === 0 || itemIndex % 5 === 0 || itemIndex === feedData.items.length - 1) {
            syncProgress.update(
              `Processing ${feed.name}: ${itemIndex + 1}/${feedData.items.length} items...`,
              feedIndex,
              feeds.length
            );
          }
          try {
            if (!item.title && !item.link) {
              continue; // Skip items without title or link
            }

            const parsed = parseRSSItem(item as any, feed.id!, feed.name);
            const guid = parsed.guid || parsed.link || '';
            
            // Check if item already exists in database
            const existingItem = db
              .prepare('SELECT tmdb_id, imdb_id, clean_title, year FROM rss_feed_items WHERE guid = ?')
              .get(guid) as { tmdb_id: number | null; imdb_id: string | null; clean_title: string | null; year: number | null } | undefined;

            // Start with IDs from RSS feed or existing database entry
            let tmdbId = (parsed as any).tmdb_id || (existingItem?.tmdb_id || null);
            let imdbId = (parsed as any).imdb_id || (existingItem?.imdb_id || null);
            const cleanTitle = (parsed as any).clean_title || existingItem?.clean_title || null;
            const year = parsed.year || existingItem?.year || null;

            // Log where IDs came from
            if (tmdbId) {
              const source = (parsed as any).tmdb_id ? 'RSS feed' : 'database';
              console.log(`    TMDB ID ${tmdbId} from ${source}`);
            }
            if (imdbId) {
              const source = (parsed as any).imdb_id ? 'RSS feed' : 'database';
              console.log(`    IMDB ID ${imdbId} from ${source}`);
            }

            // Always try to enrich if IDs are missing (for both new and existing items)
            // Also validate existing IDs to ensure they're correct
            const needsEnrichment = !tmdbId || !imdbId;

            if (needsEnrichment) {
              console.log(`  Enriching ${existingItem ? 'existing' : 'new'} item: "${parsed.title}" (TMDB: ${tmdbId || 'missing'}, IMDB: ${imdbId || 'missing'})`);
              console.log(`    Clean title: "${cleanTitle}", Year: ${year || 'none'}`);

              // Enrich with TMDB/IMDB IDs if missing
              // Priority: TMDB ID is PRIMARY (Radarr uses TMDB ID exclusively)
              // If TMDB ID is found, extract IMDB ID from TMDB (not the other way around)
              
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
              
              // Step 1: If we have TMDB ID, extract IMDB ID from TMDB (primary path)
              if (tmdbId && tmdbApiKey && !imdbId) {
                try {
                  console.log(`    Extracting IMDB ID from TMDB ID ${tmdbId}`);
                  const tmdbMovie = await tmdbClient.getMovie(tmdbId);
                  if (tmdbMovie && tmdbMovie.imdb_id) {
                    imdbId = tmdbMovie.imdb_id;
                    console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie ${tmdbId}`);
                  }
                } catch (error) {
                  console.log(`    ✗ Failed to get IMDB ID from TMDB ID ${tmdbId}:`, error);
                }
              }

              // Step 2: If we don't have TMDB ID but have clean title, try TMDB search FIRST (primary)
              if (!tmdbId && cleanTitle && tmdbApiKey) {
                try {
                  console.log(`    Searching TMDB for: "${cleanTitle}" ${year ? `(${year})` : ''}`);
                  const tmdbMovie = await tmdbClient.searchMovie(cleanTitle, year || undefined);
                  if (tmdbMovie) {
                    console.log(`    TMDB search returned: "${tmdbMovie.title}" (ID: ${tmdbMovie.id}, Year: ${tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : 'unknown'})`);
                    // Validate year match if we have a year
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
                      
                      // Extract IMDB ID from TMDB movie (primary source)
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

              // Step 2b: If still no TMDB ID and we have normalized title, try with normalized title
              if (!tmdbId && tmdbApiKey && parsed.normalized_title && parsed.normalized_title !== cleanTitle) {
                try {
                  console.log(`    Searching TMDB (normalized) for: "${parsed.normalized_title}" ${year ? `(${year})` : ''}`);
                  const tmdbMovie = await tmdbClient.searchMovie(parsed.normalized_title, year || undefined);
                  if (tmdbMovie) {
                    // Validate year match if we have a year
                    let isValidMatch = true;
                    if (year && tmdbMovie.release_date) {
                      const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
                      if (releaseYear !== year) {
                        isValidMatch = false;
                        console.log(`    ✗ TMDB result year mismatch: ${releaseYear} vs ${year}`);
                      }
                    }
                    
                    if (isValidMatch) {
                      tmdbId = tmdbMovie.id;
                      console.log(`    ✓ Found TMDB ID ${tmdbId} for "${parsed.normalized_title}"`);
                      
                      // Extract IMDB ID from TMDB movie
                      if (!imdbId && tmdbMovie.imdb_id) {
                        imdbId = tmdbMovie.imdb_id;
                        console.log(`    ✓ Found IMDB ID ${imdbId} from TMDB movie`);
                      }
                    }
                  }
                } catch (error) {
                  console.log(`    ✗ Failed to find TMDB ID for "${parsed.normalized_title}":`, error);
                }
              }

              // Step 2c: If still no TMDB ID, try Brave Search as fallback for TMDB
              if (!tmdbId && cleanTitle && braveApiKey && !braveRateLimited) {
                try {
                  const braveTmdbId = await braveClient.searchForTmdbId(cleanTitle, year || undefined);
                  if (braveTmdbId) {
                    tmdbId = braveTmdbId;
                    console.log(`    ✓ Found TMDB ID ${tmdbId} via Brave search`);
                    
                    // Extract IMDB ID from TMDB movie
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
                } catch (error: any) {
                  if (error?.message === 'BRAVE_RATE_LIMITED') {
                    braveRateLimited = true;
                    console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for remaining items.`);
                  } else {
                    console.log(`    ✗ Failed to find TMDB ID via Brave for "${cleanTitle}":`, error);
                  }
                }
              }

              // Step 3: Only if we still don't have TMDB ID, try IMDB search as last resort
              // (But note: if we find IMDB but not TMDB, the movie won't work with Radarr)
              if (!tmdbId && !imdbId && cleanTitle && (omdbApiKey || true)) {
                try {
                  console.log(`    Searching IMDB (OMDB) for: "${cleanTitle}" ${year ? `(${year})` : ''} (fallback - will try to get TMDB from IMDB)`);
                  const imdbResult = await imdbClient.searchMovie(cleanTitle, year || undefined);
                  if (imdbResult) {
                    imdbId = imdbResult.imdbId;
                    console.log(`    ✓ Found IMDB ID ${imdbId} for "${cleanTitle}" (OMDB returned: "${imdbResult.title}" ${imdbResult.year})`);
                    
                    // Try to get TMDB ID from IMDB ID (secondary path - only if TMDB search failed)
                    if (!tmdbId && tmdbApiKey) {
                      try {
                        const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                        if (tmdbMovie) {
                          tmdbId = tmdbMovie.id;
                          console.log(`    ✓ Found TMDB ID ${tmdbId} from IMDB ID ${imdbId}`);
                        } else {
                          console.log(`    ⚠ Found IMDB ID ${imdbId} but no TMDB ID - movie may not work with Radarr`);
                        }
                      } catch (error) {
                        console.log(`    ⚠ Found IMDB ID ${imdbId} but failed to get TMDB ID - movie may not work with Radarr`);
                      }
                    }
                  } else {
                    console.log(`    ✗ OMDB search returned no results for "${cleanTitle}" ${year ? `(${year})` : ''}`);
                  }
                } catch (error: any) {
                  console.log(`    ✗ Failed to find IMDB ID via OMDB for "${cleanTitle}":`, error?.message || error);
                }
              }

              // Step 3b: If still no TMDB ID, try Brave Search for IMDB as last resort
              if (!tmdbId && !imdbId && cleanTitle && braveApiKey && !braveRateLimited) {
                try {
                  const braveImdbId = await braveClient.searchForImdbId(cleanTitle, year || undefined);
                  if (braveImdbId) {
                    imdbId = braveImdbId;
                    console.log(`    ✓ Found IMDB ID ${imdbId} via Brave search`);
                    
                    // Try to get TMDB ID from IMDB ID
                    if (!tmdbId && tmdbApiKey) {
                      try {
                        const tmdbMovie = await tmdbClient.findMovieByImdbId(imdbId);
                        if (tmdbMovie) {
                          tmdbId = tmdbMovie.id;
                          console.log(`    ✓ Found TMDB ID ${tmdbId} from IMDB ID ${imdbId}`);
                        } else {
                          console.log(`    ⚠ Found IMDB ID ${imdbId} but no TMDB ID - movie may not work with Radarr`);
                        }
                      } catch (error) {
                        console.log(`    ⚠ Found IMDB ID ${imdbId} but failed to get TMDB ID - movie may not work with Radarr`);
                      }
                    }
                  }
                } catch (error: any) {
                  if (error?.message === 'BRAVE_RATE_LIMITED') {
                    braveRateLimited = true;
                    console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for remaining items.`);
                  } else {
                    console.log(`    ✗ Failed to find IMDB ID via Brave for "${cleanTitle}":`, error);
                  }
                }
              }
            }

            enrichedItems.push({
              parsed,
              tmdbId: tmdbId || null,
              imdbId: imdbId || null,
              originalItem: item,
              guid,
            });
          } catch (itemError: any) {
            console.error(`Error enriching RSS item: ${item.title || item.link}`, itemError);
            // Still add the item without enrichment
            const parsed = parseRSSItem(item as any, feed.id!, feed.name);
            enrichedItems.push({
              parsed,
              tmdbId: null,
              imdbId: null,
              originalItem: item,
              guid: parsed.guid || parsed.link || '',
            });
          }
        }

        // Use transaction for better performance
        const transaction = db.transaction(() => {
          for (const { parsed, tmdbId, imdbId, originalItem, guid } of enrichedItems) {
            try {
              // Check if item already exists (need to check manual flags)
              const existing = db
                .prepare('SELECT id, tmdb_id_manual, imdb_id_manual, tmdb_id, imdb_id FROM rss_feed_items WHERE guid = ?')
                .get(guid) as { id: number; tmdb_id_manual: number | null; imdb_id_manual: number | null; tmdb_id: number | null; imdb_id: string | null } | undefined;

              const itemData = {
                guid,
                feed_id: feed.id!,
                feed_name: feed.name,
                title: parsed.title,
                normalized_title: parsed.normalized_title,
                clean_title: (parsed as any).clean_title || null,
                year: parsed.year || null,
                source_site: parsed.source_site,
                link: parsed.link,
                resolution: parsed.resolution,
                source_tag: parsed.source_tag,
                codec: parsed.codec,
                audio: parsed.audio,
                rss_size_mb: parsed.rss_size_mb || null,
                published_at: parsed.published_at,
                tmdb_id: tmdbId || null, // Use enriched TMDB ID (primary)
                imdb_id: imdbId || null, // Use enriched IMDB ID (secondary)
                audio_languages: parsed.audio_languages || null,
                raw_data: JSON.stringify(parsed),
                synced_at: new Date().toISOString(),
              };

              if (existing) {
                // Preserve manually set IDs - don't overwrite if they were manually set
                const preserveTmdbId = existing.tmdb_id_manual ? existing.tmdb_id : itemData.tmdb_id;
                const preserveImdbId = existing.imdb_id_manual ? existing.imdb_id : itemData.imdb_id;
                
                // Update existing
                db.prepare(`
                  UPDATE rss_feed_items SET
                    feed_id = ?,
                    feed_name = ?,
                    title = ?,
                    normalized_title = ?,
                    clean_title = ?,
                    year = ?,
                    source_site = ?,
                    link = ?,
                    resolution = ?,
                    source_tag = ?,
                    codec = ?,
                    audio = ?,
                    rss_size_mb = ?,
                    published_at = ?,
                    tmdb_id = ?,
                    imdb_id = ?,
                    audio_languages = ?,
                    raw_data = ?,
                    synced_at = ?
                  WHERE guid = ?
                `).run(
                  itemData.feed_id,
                  itemData.feed_name,
                  itemData.title,
                  itemData.normalized_title,
                  itemData.clean_title,
                  itemData.year,
                  itemData.source_site,
                  itemData.link,
                  itemData.resolution,
                  itemData.source_tag,
                  itemData.codec,
                  itemData.audio,
                  itemData.rss_size_mb,
                  itemData.published_at,
                  preserveTmdbId,
                  preserveImdbId,
                  itemData.audio_languages,
                  itemData.raw_data,
                  itemData.synced_at,
                  guid
                );
                stats.itemsUpdated++;
              } else {
                // Insert new
                db.prepare(`
                  INSERT INTO rss_feed_items (
                    guid, feed_id, feed_name, title, normalized_title, clean_title,
                    year, source_site, link, resolution, source_tag, codec, audio,
                    rss_size_mb, published_at, tmdb_id, imdb_id, audio_languages,
                    raw_data, synced_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  itemData.guid,
                  itemData.feed_id,
                  itemData.feed_name,
                  itemData.title,
                  itemData.normalized_title,
                  itemData.clean_title,
                  itemData.year,
                  itemData.source_site,
                  itemData.link,
                  itemData.resolution,
                  itemData.source_tag,
                  itemData.codec,
                  itemData.audio,
                  itemData.rss_size_mb,
                  itemData.published_at,
                  itemData.tmdb_id,
                  itemData.imdb_id,
                  itemData.audio_languages,
                  itemData.raw_data,
                  itemData.synced_at
                );
                stats.itemsSynced++;
              }
            } catch (itemError: any) {
              console.error(`Error processing RSS item: ${parsed.title || parsed.link}`, itemError);
              // Continue processing other items
            }
          }
        });

        transaction();
        stats.feedsProcessed++;
        console.log(`Feed ${feed.name}: Synced ${feedData.items.length} items`);
        syncProgress.update(`Completed ${feed.name} (${feedData.items.length} items)`, feedIndex + 1, feeds.length, stats.errors.length);
      } catch (feedError: any) {
        stats.errors.push({
          feedId: feed.id!,
          feedName: feed.name,
          error: feedError?.message || 'Unknown error',
        });
        console.error(`Error syncing feed: ${feed.name}`, feedError);
        stats.feedsProcessed++;
      }
    }

    // Update last sync timestamp
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('rss_last_sync', ?)").run(
      stats.lastSyncAt.toISOString()
    );

    console.log(`RSS sync completed: ${stats.feedsProcessed}/${stats.totalFeeds} feeds, ${stats.itemsSynced} new items, ${stats.itemsUpdated} updated items, ${stats.errors.length} errors`);
    
    // Mark sync as complete
    syncProgress.update('Sync completed', stats.feedsProcessed, stats.totalFeeds, stats.errors.length);
    syncProgress.complete();
    
    return stats;
  } catch (error: any) {
    console.error('RSS sync error:', error);
    syncProgress.update(`Error: ${error?.message || 'Unknown error'}`, 0, 0, 1);
    syncProgress.complete();
    throw error;
  }
}

/**
 * Get all synced RSS feed items
 */
export function getSyncedRssItems(feedId?: number): any[] {
  // Use datetime() to ensure proper date sorting (SQLite TEXT dates need explicit datetime conversion)
  if (feedId) {
    return db.prepare('SELECT * FROM rss_feed_items WHERE feed_id = ? ORDER BY datetime(published_at) DESC').all(feedId);
  }
  // Sort by published_at DESC (newest first) - this is the feed release date
  // Use datetime() to ensure proper date sorting
  return db.prepare('SELECT * FROM rss_feed_items ORDER BY datetime(published_at) DESC').all();
}

/**
 * Get RSS items grouped by feed
 */
export function getSyncedRssItemsByFeed(): Array<{ feedId: number; feedName: string; itemCount: number; lastSync: string }> {
  return db.prepare(`
    SELECT 
      feed_id as feedId,
      feed_name as feedName,
      COUNT(*) as itemCount,
      MAX(synced_at) as lastSync
    FROM rss_feed_items
    GROUP BY feed_id, feed_name
    ORDER BY feed_name
  `).all() as any[];
}

/**
 * Get last sync timestamp
 */
export function getLastRssSync(): Date | null {
  const result = db.prepare("SELECT value FROM app_settings WHERE key = 'rss_last_sync'").get() as { value: string } | undefined;
  return result ? new Date(result.value) : null;
}

/**
 * Backfill missing TMDB/IMDB IDs for all existing RSS items
 * This processes all items in the database that are missing IDs, not just items from current RSS feed
 */
export async function backfillMissingIds(): Promise<{ processed: number; updated: number; errors: number }> {
  const stats = {
    processed: 0,
    updated: 0,
    errors: 0,
  };

  // Track if Brave search is rate limited to skip it for remaining items
  let braveRateLimited = false;

  try {
    console.log('Starting backfill of missing TMDB/IMDB IDs for existing RSS items...');
    
    // Get all items missing TMDB or IMDB IDs, OR items with both IDs (to validate they match)
    // Exclude items with manually set IDs (they won't be overwritten)
    const itemsToEnrich = db.prepare(`
      SELECT id, guid, title, clean_title, year, tmdb_id, imdb_id, tmdb_id_manual, imdb_id_manual, feed_id, feed_name, raw_data, link
      FROM rss_feed_items
      WHERE (tmdb_id IS NULL OR imdb_id IS NULL OR (tmdb_id IS NOT NULL AND imdb_id IS NOT NULL))
        AND (tmdb_id_manual = 0 OR tmdb_id_manual IS NULL)
        AND (imdb_id_manual = 0 OR imdb_id_manual IS NULL)
      ORDER BY id
    `).all() as Array<{
      id: number;
      guid: string;
      title: string;
      clean_title: string | null;
      year: number | null;
      tmdb_id: number | null;
      imdb_id: string | null;
      tmdb_id_manual: number | null;
      imdb_id_manual: number | null;
      feed_id: number;
      feed_name: string;
      raw_data: string | null;
      link: string;
    }>;

    console.log(`Found ${itemsToEnrich.length} items missing TMDB or IMDB IDs`);

    if (itemsToEnrich.length === 0) {
      return stats;
    }

    // Get API keys
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    const omdbApiKey = allSettings.find(s => s.key === 'omdb_api_key')?.value;
    const braveApiKey = allSettings.find(s => s.key === 'brave_api_key')?.value;
    
    if (tmdbApiKey) tmdbClient.setApiKey(tmdbApiKey);
    if (omdbApiKey) imdbClient.setApiKey(omdbApiKey);
    if (braveApiKey) braveClient.setApiKey(braveApiKey);

    // Process each item
    for (let i = 0; i < itemsToEnrich.length; i++) {
      const item = itemsToEnrich[i];
      stats.processed++;

      // Update progress every 10 items
      if (i % 10 === 0 || i === itemsToEnrich.length - 1) {
        syncProgress.update(
          `Backfilling IDs: ${i + 1}/${itemsToEnrich.length} items...`,
          i,
          itemsToEnrich.length
        );
      }

      try {
        console.log(`[${i + 1}/${itemsToEnrich.length}] Processing: "${item.title}" (ID: ${item.id}, TMDB: ${item.tmdb_id || 'missing'}, IMDB: ${item.imdb_id || 'missing'})`);

        // Re-parse the item if we have raw_data, otherwise use existing data
        let parsed: any;
        let cleanTitle = item.clean_title;
        let year = item.year;

        if (item.raw_data) {
          try {
            const rawItem = JSON.parse(item.raw_data);
            parsed = parseRSSItem({
              title: item.title,
              link: item.link,
              guid: item.guid,
              description: rawItem.description || '',
            } as any, item.feed_id, item.feed_name);
            cleanTitle = (parsed as any).clean_title || item.clean_title;
            year = parsed.year || item.year;
          } catch {
            // If parsing fails, use existing data
            parsed = { title: item.title, normalized_title: item.title };
          }
        } else {
          parsed = { title: item.title, normalized_title: item.title };
        }

        let tmdbId = item.tmdb_id;
        let imdbId = item.imdb_id;

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

        // Run enrichment logic (same as in syncRssFeeds)
        const needsEnrichment = !tmdbId || !imdbId;

        if (needsEnrichment && cleanTitle) {
          console.log(`  Enriching item: "${item.title}" (TMDB: ${tmdbId || 'missing'}, IMDB: ${imdbId || 'missing'})`);
          console.log(`    Clean title: "${cleanTitle}", Year: ${year || 'none'}`);

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
          if (!imdbId && cleanTitle && braveApiKey && !braveRateLimited) {
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
            } catch (error: any) {
              if (error?.message === 'BRAVE_RATE_LIMITED') {
                braveRateLimited = true;
                console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for remaining items.`);
              } else {
                console.log(`    ✗ Failed to find IMDB ID via Brave for "${cleanTitle}":`, error);
              }
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
          if (!tmdbId && cleanTitle && braveApiKey && !braveRateLimited) {
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
            } catch (error: any) {
              if (error?.message === 'BRAVE_RATE_LIMITED') {
                braveRateLimited = true;
                console.log(`    ⚠️ Brave API rate limit reached. Skipping Brave search for remaining items.`);
              } else {
                console.log(`    ✗ Failed to find TMDB ID via Brave for "${cleanTitle}":`, error);
              }
            }
          }
        }

        // Update database if we found new IDs, but preserve manually set IDs
        const preserveTmdbId = item.tmdb_id_manual ? item.tmdb_id : tmdbId;
        const preserveImdbId = item.imdb_id_manual ? item.imdb_id : imdbId;
        
        if (preserveTmdbId !== item.tmdb_id || preserveImdbId !== item.imdb_id) {
          db.prepare(`
            UPDATE rss_feed_items 
            SET tmdb_id = ?, imdb_id = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(preserveTmdbId, preserveImdbId, item.id);
          
          stats.updated++;
          console.log(`  ✓ Updated item ${item.id}: TMDB=${preserveTmdbId || 'null'}${item.tmdb_id_manual ? ' (manual)' : ''}, IMDB=${preserveImdbId || 'null'}${item.imdb_id_manual ? ' (manual)' : ''}`);
        } else {
          console.log(`  ℹ No changes needed for item ${item.id}${item.tmdb_id_manual || item.imdb_id_manual ? ' (has manual IDs)' : ''}`);
        }

      } catch (error: any) {
        stats.errors++;
        console.error(`  ✗ Error processing item ${item.id} ("${item.title}"):`, error?.message || error);
      }
    }

    console.log(`Backfill completed: ${stats.processed} processed, ${stats.updated} updated, ${stats.errors} errors`);
    return stats;
  } catch (error: any) {
    console.error('Backfill missing IDs error:', error);
    throw error;
  }
}

