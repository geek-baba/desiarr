import db from '../db';
import { TMDBClient, TMDBMovie } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { syncProgress } from './syncProgress';
import { logger } from './structuredLogging';

export interface TmdbSyncStats {
  totalMovies: number;
  moviesSynced: number;
  moviesUpdated: number;
  moviesDeleted: number;
  errors: string[];
  lastSyncAt: Date | null;
}

/**
 * Initial sync: Fetch TMDB data for all movies in Radarr
 * Supports resume: skips movies that are already synced (have synced_at and is_deleted = 0)
 */
export async function initialTmdbSync(resume: boolean = true): Promise<TmdbSyncStats> {
  const stats: TmdbSyncStats = {
    totalMovies: 0,
    moviesSynced: 0,
    moviesUpdated: 0,
    moviesDeleted: 0,
    errors: [],
    lastSyncAt: null,
  };

  // Generate unique job ID for this sync session
  const jobId = `tmdb-sync-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      stats.errors.push('TMDB API key not configured');
      logger.error('tmdb', 'TMDB API key not configured', { jobId });
      return stats;
    }

    tmdbClient.setApiKey(tmdbApiKey);

    // Get all unique tmdb_ids from radarr_movies
    const allMovies = db
      .prepare(`
        SELECT DISTINCT tmdb_id
        FROM radarr_movies
        WHERE tmdb_id IS NOT NULL
        ORDER BY tmdb_id
      `)
      .all() as Array<{ tmdb_id: number }>;

    // If resume is enabled, filter out movies that are already synced
    let movies: Array<{ tmdb_id: number }>;
    let alreadySynced = 0;

    if (resume) {
      // Get list of already synced movies (have synced_at and is_deleted = 0)
      const syncedMovies = new Set(
        (db.prepare(`
          SELECT tmdb_id FROM tmdb_movie_cache 
          WHERE synced_at IS NOT NULL AND is_deleted = 0
        `).all() as Array<{ tmdb_id: number }>).map(row => row.tmdb_id)
      );

      movies = allMovies.filter(m => !syncedMovies.has(m.tmdb_id));
      alreadySynced = allMovies.length - movies.length;

      if (alreadySynced > 0) {
        logger.info('tmdb', `Resuming sync: ${alreadySynced} movies already synced, ${movies.length} remaining`, {
          jobId,
          details: { alreadySynced, remaining: movies.length, total: allMovies.length }
        });
      }
    } else {
      movies = allMovies;
    }

    stats.totalMovies = movies.length;

    if (stats.totalMovies === 0) {
      if (alreadySynced > 0) {
        logger.info('tmdb', 'All movies already synced', { jobId, details: { total: allMovies.length } });
      } else {
        logger.info('tmdb', 'No movies to sync', { jobId });
      }
      return stats;
    }

    syncProgress.start('tmdb-sync', 0);
    syncProgress.update(`Starting TMDB sync for ${stats.totalMovies} movies...`, 0, stats.totalMovies);
    logger.info('tmdb', `Starting initial sync for ${stats.totalMovies} movies${alreadySynced > 0 ? ` (${alreadySynced} already synced)` : ''}`, {
      jobId,
      details: { totalMovies: stats.totalMovies, alreadySynced, resume }
    });

    const BATCH_SIZE = 50;
    const RATE_LIMIT_DELAY = 350; // 350ms = ~3 requests/second
    const CHECKPOINT_INTERVAL = 10; // Save checkpoint every 10 batches

    for (let i = 0; i < movies.length; i += BATCH_SIZE) {
      const batch = movies.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(movies.length / BATCH_SIZE);

      syncProgress.update(
        `Processing batch ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + BATCH_SIZE, movies.length)} of ${movies.length})...`,
        stats.moviesSynced + stats.moviesDeleted,
        movies.length
      );

      // Log batch start
      if (batchNum % 10 === 0 || batchNum === 1) {
        logger.info('tmdb', `Processing batch ${batchNum}/${totalBatches}`, {
          jobId,
          details: {
            batch: batchNum,
            totalBatches,
            processed: stats.moviesSynced + stats.moviesDeleted,
            total: stats.totalMovies,
            errors: stats.errors.length
          }
        });
      }

      for (const movie of batch) {
        try {
          logger.debug('tmdb', `Fetching TMDB data for movie ${movie.tmdb_id}`, { jobId, details: { tmdbId: movie.tmdb_id } });

          const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);

          if (!tmdbMovie) {
            // Movie not found - mark as deleted
            logger.warn('tmdb', `TMDB movie ${movie.tmdb_id} not found (404) - marking as deleted`, {
              jobId,
              details: { tmdbId: movie.tmdb_id }
            });
            db.prepare(`
              INSERT OR REPLACE INTO tmdb_movie_cache (
                tmdb_id, is_deleted, synced_at
              ) VALUES (?, 1, datetime('now'))
            `).run(movie.tmdb_id);
            stats.moviesDeleted++;
            continue;
          }

          // Extract primary country
          const primaryCountry = tmdbMovie.production_countries && tmdbMovie.production_countries.length > 0
            ? tmdbMovie.production_countries[0].name
            : null;

          // Store in cache with all fields
          db.prepare(`
            INSERT OR REPLACE INTO tmdb_movie_cache (
              tmdb_id, title, original_title, original_language, release_date,
              production_countries, primary_country, poster_path, backdrop_path,
              overview, tagline, imdb_id, genres, production_companies, spoken_languages,
              belongs_to_collection, budget, revenue, runtime, popularity, vote_average,
              vote_count, status, adult, video, homepage,
              synced_at, last_updated_at, is_deleted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
          `).run(
            tmdbMovie.id,
            tmdbMovie.title || null,
            tmdbMovie.original_title || null,
            tmdbMovie.original_language || null,
            tmdbMovie.release_date || null,
            tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
            primaryCountry,
            tmdbMovie.poster_path || null,
            tmdbMovie.backdrop_path || null,
            tmdbMovie.overview || null,
            tmdbMovie.tagline || null,
            tmdbMovie.imdb_id || null,
            tmdbMovie.genres ? JSON.stringify(tmdbMovie.genres) : null,
            tmdbMovie.production_companies ? JSON.stringify(tmdbMovie.production_companies) : null,
            tmdbMovie.spoken_languages ? JSON.stringify(tmdbMovie.spoken_languages) : null,
            tmdbMovie.belongs_to_collection ? JSON.stringify(tmdbMovie.belongs_to_collection) : null,
            tmdbMovie.budget || null,
            tmdbMovie.revenue || null,
            tmdbMovie.runtime || null,
            tmdbMovie.popularity || null,
            tmdbMovie.vote_average || null,
            tmdbMovie.vote_count || null,
            tmdbMovie.status || null,
            tmdbMovie.adult ? 1 : 0,
            tmdbMovie.video ? 1 : 0,
            tmdbMovie.homepage || null
          );

          logger.debug('tmdb', `Synced movie: ${tmdbMovie.title || tmdbMovie.original_title || `TMDB ${movie.tmdb_id}`}`, {
            jobId,
            details: {
              tmdbId: movie.tmdb_id,
              title: tmdbMovie.title,
              originalTitle: tmdbMovie.original_title,
              language: tmdbMovie.original_language,
              country: primaryCountry
            }
          });

          stats.moviesSynced++;
        } catch (error: any) {
          const errorMsg = `Failed to sync TMDB ID ${movie.tmdb_id}: ${error?.message || 'Unknown error'}`;
          stats.errors.push(errorMsg);
          logger.error('tmdb', errorMsg, {
            jobId,
            error: error instanceof Error ? error : new Error(String(error)),
            details: { tmdbId: movie.tmdb_id }
          });
        }

        // Rate limit: wait between requests
        if (i + batch.indexOf(movie) < movies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }
      }

      // Save checkpoint every N batches to track progress
      if (batchNum % CHECKPOINT_INTERVAL === 0) {
        logger.info('tmdb', `Checkpoint: ${stats.moviesSynced + stats.moviesDeleted}/${stats.totalMovies} movies processed`, {
          jobId,
          details: {
            synced: stats.moviesSynced,
            deleted: stats.moviesDeleted,
            errors: stats.errors.length,
            total: stats.totalMovies,
            progress: Math.round(((stats.moviesSynced + stats.moviesDeleted) / stats.totalMovies) * 100)
          }
        });
        // Save partial progress timestamp (for debugging)
        db.prepare(`
          INSERT OR REPLACE INTO app_settings (key, value)
          VALUES ('tmdb_last_checkpoint', datetime('now'))
        `).run();
      }
    }

    // Update last sync date (use datetime for timezone-aware calculations)
    logger.info('tmdb', `Sync completed: ${stats.moviesSynced} synced, ${stats.moviesDeleted} deleted, ${stats.errors.length} errors`, {
      jobId,
      details: {
        synced: stats.moviesSynced,
        deleted: stats.moviesDeleted,
        updated: stats.moviesUpdated,
        errors: stats.errors.length,
        total: stats.totalMovies
      }
    });
    // Store as ISO string like other sync functions do (with UTC timezone indicator)
    const syncCompleteTime = new Date();
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value)
      VALUES ('tmdb_last_sync_date', ?)
    `).run(syncCompleteTime.toISOString());

    stats.lastSyncAt = syncCompleteTime;
    syncProgress.complete();
  } catch (error: any) {
    const errorMsg = `Sync failed: ${error?.message || 'Unknown error'}`;
    stats.errors.push(errorMsg);
    logger.error('tmdb', 'Initial sync error', {
      jobId,
      error: error instanceof Error ? error : new Error(String(error)),
      details: {
        partialProgress: `${stats.moviesSynced + stats.moviesDeleted}/${stats.totalMovies}`,
        synced: stats.moviesSynced,
        deleted: stats.moviesDeleted,
        errors: stats.errors.length
      }
    });
    // Save checkpoint even on error so we know where we stopped
    if (stats.moviesSynced + stats.moviesDeleted > 0) {
      db.prepare(`
        INSERT OR REPLACE INTO app_settings (key, value)
        VALUES ('tmdb_last_checkpoint', datetime('now'))
      `).run();
      logger.info('tmdb', 'Saved checkpoint before error', { jobId });
    }
    syncProgress.complete();
  }

  return stats;
}

/**
 * Incremental sync: Fetch only changed movies using /movie/changes endpoint
 */
export async function incrementalTmdbSync(): Promise<TmdbSyncStats> {
  const stats: TmdbSyncStats = {
    totalMovies: 0,
    moviesSynced: 0,
    moviesUpdated: 0,
    moviesDeleted: 0,
    errors: [],
    lastSyncAt: null,
  };

  // Generate unique job ID for this sync session (outside try block so it's available in catch)
  const jobId = `tmdb-sync-incremental-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      stats.errors.push('TMDB API key not configured');
      logger.error('tmdb', 'TMDB API key not configured', { jobId });
      return stats;
    }

    tmdbClient.setApiKey(tmdbApiKey);

    // Get last sync date
    const lastSyncSetting = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('tmdb_last_sync_date') as { value: string } | undefined;

    const lastSyncDate = lastSyncSetting?.value || null;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (!lastSyncDate) {
      // No previous sync - do initial sync instead
      logger.info('tmdb', 'No previous TMDB sync found, running initial sync...', { jobId });
      return await initialTmdbSync(true);
    }

    // Get changed movie IDs from TMDB
    logger.info('tmdb', `Fetching TMDB changes from ${lastSyncDate} to ${today}...`, { jobId });
    syncProgress.start('tmdb-sync', 0);
    syncProgress.update('Fetching list of changed movies from TMDB...', 0);

    const changedIds = await tmdbClient.getMovieChanges(lastSyncDate, today);
    stats.totalMovies = changedIds.length;
    logger.info('tmdb', `Found ${changedIds.length} changed movies in TMDB`, {
      jobId,
      details: { changedCount: changedIds.length, dateRange: { from: lastSyncDate, to: today } }
    });

    if (stats.totalMovies === 0) {
      syncProgress.complete();
      stats.lastSyncAt = new Date();
      return stats;
    }

    // Get tmdb_ids that exist in radarr_movies (we only care about movies we have)
    const radarrTmdbIds = new Set(
      (db.prepare('SELECT DISTINCT tmdb_id FROM radarr_movies WHERE tmdb_id IS NOT NULL').all() as Array<{ tmdb_id: number }>)
        .map(row => row.tmdb_id)
    );

    // Filter to only movies we have in Radarr
    const relevantChangedIds = changedIds.filter(id => radarrTmdbIds.has(id));

    if (relevantChangedIds.length === 0) {
      logger.info('tmdb', 'No relevant changes found (none of the changed movies are in Radarr)', { jobId });
      syncProgress.complete();
      // Still update sync date (use datetime for timezone-aware calculations)
      // Store as ISO string like other sync functions do (with UTC timezone indicator)
      const syncCompleteTime = new Date();
      db.prepare(`
        INSERT OR REPLACE INTO app_settings (key, value)
        VALUES ('tmdb_last_sync_date', ?)
      `).run(syncCompleteTime.toISOString());
      stats.lastSyncAt = syncCompleteTime;
      return stats;
    }

    logger.info('tmdb', `Processing ${relevantChangedIds.length} relevant changed movies (out of ${stats.totalMovies} total changes)`, {
      jobId,
      details: { relevant: relevantChangedIds.length, total: stats.totalMovies }
    });
    syncProgress.update(`Updating ${relevantChangedIds.length} movies...`, 0, relevantChangedIds.length);

    const RATE_LIMIT_DELAY = 350; // 350ms = ~3 requests/second

    for (let i = 0; i < relevantChangedIds.length; i++) {
      const tmdbId = relevantChangedIds[i];

      try {
        logger.debug('tmdb', `Fetching updated TMDB data for movie ${tmdbId}`, {
          jobId,
          details: { tmdbId, progress: `${i + 1}/${relevantChangedIds.length}` }
        });

        const tmdbMovie = await tmdbClient.getMovie(tmdbId);

        if (!tmdbMovie) {
          // Movie deleted from TMDB
          logger.warn('tmdb', `TMDB movie ${tmdbId} deleted from TMDB - marking as deleted`, {
            jobId,
            details: { tmdbId }
          });
          db.prepare(`
            UPDATE tmdb_movie_cache
            SET is_deleted = 1, last_updated_at = datetime('now')
            WHERE tmdb_id = ?
          `).run(tmdbId);
          stats.moviesDeleted++;
        } else {
          // Extract primary country
          const primaryCountry = tmdbMovie.production_countries && tmdbMovie.production_countries.length > 0
            ? tmdbMovie.production_countries[0].name
            : null;

          // Update cache
          const existing = db.prepare('SELECT tmdb_id FROM tmdb_movie_cache WHERE tmdb_id = ?').get(tmdbId);

          if (existing) {
            db.prepare(`
              UPDATE tmdb_movie_cache SET
                title = ?, original_title = ?, original_language = ?, release_date = ?,
                production_countries = ?, primary_country = ?, poster_path = ?,
                backdrop_path = ?, overview = ?, tagline = ?, imdb_id = ?,
                genres = ?, production_companies = ?, spoken_languages = ?,
                belongs_to_collection = ?, budget = ?, revenue = ?, runtime = ?,
                popularity = ?, vote_average = ?, vote_count = ?, status = ?,
                adult = ?, video = ?, homepage = ?,
                last_updated_at = datetime('now'), is_deleted = 0
              WHERE tmdb_id = ?
            `).run(
              tmdbMovie.title || null,
              tmdbMovie.original_title || null,
              tmdbMovie.original_language || null,
              tmdbMovie.release_date || null,
              tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
              primaryCountry,
              tmdbMovie.poster_path || null,
              tmdbMovie.backdrop_path || null,
              tmdbMovie.overview || null,
              tmdbMovie.tagline || null,
              tmdbMovie.imdb_id || null,
              tmdbMovie.genres ? JSON.stringify(tmdbMovie.genres) : null,
              tmdbMovie.production_companies ? JSON.stringify(tmdbMovie.production_companies) : null,
              tmdbMovie.spoken_languages ? JSON.stringify(tmdbMovie.spoken_languages) : null,
              tmdbMovie.belongs_to_collection ? JSON.stringify(tmdbMovie.belongs_to_collection) : null,
              tmdbMovie.budget || null,
              tmdbMovie.revenue || null,
              tmdbMovie.runtime || null,
              tmdbMovie.popularity || null,
              tmdbMovie.vote_average || null,
              tmdbMovie.vote_count || null,
              tmdbMovie.status || null,
              tmdbMovie.adult ? 1 : 0,
              tmdbMovie.video ? 1 : 0,
              tmdbMovie.homepage || null,
              tmdbId
            );
            logger.debug('tmdb', `Updated movie: ${tmdbMovie.title || tmdbMovie.original_title || `TMDB ${tmdbId}`}`, {
              jobId,
              details: { tmdbId, title: tmdbMovie.title, originalTitle: tmdbMovie.original_title }
            });
            stats.moviesUpdated++;
          } else {
            // New movie (shouldn't happen in incremental, but handle it)
            logger.info('tmdb', `New movie found during incremental sync: ${tmdbMovie.title || tmdbMovie.original_title || `TMDB ${tmdbId}`}`, {
              jobId,
              details: { tmdbId, title: tmdbMovie.title, originalTitle: tmdbMovie.original_title }
            });
            db.prepare(`
              INSERT INTO tmdb_movie_cache (
                tmdb_id, title, original_title, original_language, release_date,
                production_countries, primary_country, poster_path, backdrop_path,
                overview, tagline, imdb_id, genres, production_companies, spoken_languages,
                belongs_to_collection, budget, revenue, runtime, popularity, vote_average,
                vote_count, status, adult, video, homepage,
                synced_at, last_updated_at, is_deleted
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
            `).run(
              tmdbMovie.id,
              tmdbMovie.title || null,
              tmdbMovie.original_title || null,
              tmdbMovie.original_language || null,
              tmdbMovie.release_date || null,
              tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
              primaryCountry,
              tmdbMovie.poster_path || null,
              tmdbMovie.backdrop_path || null,
              tmdbMovie.overview || null,
              tmdbMovie.tagline || null,
              tmdbMovie.imdb_id || null,
              tmdbMovie.genres ? JSON.stringify(tmdbMovie.genres) : null,
              tmdbMovie.production_companies ? JSON.stringify(tmdbMovie.production_companies) : null,
              tmdbMovie.spoken_languages ? JSON.stringify(tmdbMovie.spoken_languages) : null,
              tmdbMovie.belongs_to_collection ? JSON.stringify(tmdbMovie.belongs_to_collection) : null,
              tmdbMovie.budget || null,
              tmdbMovie.revenue || null,
              tmdbMovie.runtime || null,
              tmdbMovie.popularity || null,
              tmdbMovie.vote_average || null,
              tmdbMovie.vote_count || null,
              tmdbMovie.status || null,
              tmdbMovie.adult ? 1 : 0,
              tmdbMovie.video ? 1 : 0,
              tmdbMovie.homepage || null
            );
            stats.moviesSynced++;
          }
        }

        syncProgress.update(
          `Updated ${stats.moviesSynced + stats.moviesUpdated + stats.moviesDeleted}/${relevantChangedIds.length} movies...`,
          stats.moviesSynced + stats.moviesUpdated + stats.moviesDeleted,
          relevantChangedIds.length
        );

        // Rate limit: wait between requests
        if (i < relevantChangedIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }
      } catch (error: any) {
        // Handle rate limiting with exponential backoff
        if (error?.response?.status === 429) {
          const retryAfter = parseInt(error?.response?.headers?.['retry-after'] || '10', 10);
          logger.warn('tmdb', `Rate limited, waiting ${retryAfter} seconds...`, {
            jobId,
            details: { tmdbId, retryAfter }
          });
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          // Retry this movie
          i--;
          continue;
        }

        const errorMsg = `Failed to sync TMDB ID ${tmdbId}: ${error?.message || 'Unknown error'}`;
        stats.errors.push(errorMsg);
        logger.error('tmdb', errorMsg, {
          jobId,
          error: error instanceof Error ? error : new Error(String(error)),
          details: { tmdbId }
        });
      }
    }

    // Update last sync date (use datetime for timezone-aware calculations)
    logger.info('tmdb', `Incremental sync completed: ${stats.moviesUpdated} updated, ${stats.moviesSynced} new, ${stats.moviesDeleted} deleted, ${stats.errors.length} errors`, {
      jobId,
      details: {
        updated: stats.moviesUpdated,
        synced: stats.moviesSynced,
        deleted: stats.moviesDeleted,
        errors: stats.errors.length,
        total: stats.totalMovies
      }
    });
    // Store as ISO string like other sync functions do (with UTC timezone indicator)
    const syncCompleteTime = new Date();
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value)
      VALUES ('tmdb_last_sync_date', ?)
    `).run(syncCompleteTime.toISOString());

    stats.lastSyncAt = syncCompleteTime;
    syncProgress.complete();
  } catch (error: any) {
    const errorMsg = `Incremental sync failed: ${error?.message || 'Unknown error'}`;
    stats.errors.push(errorMsg);
    logger.error('tmdb', 'Incremental sync error', {
      jobId,
      error: error instanceof Error ? error : new Error(String(error)),
      details: {
        partialProgress: `${stats.moviesUpdated + stats.moviesSynced + stats.moviesDeleted}/${stats.totalMovies}`,
        updated: stats.moviesUpdated,
        synced: stats.moviesSynced,
        deleted: stats.moviesDeleted,
        errors: stats.errors.length
      }
    });
    syncProgress.complete();
  }

  return stats;
}

/**
 * Get sync status
 */
export function getTmdbSyncStatus(): {
  lastSyncDate: Date | null;
  totalCached: number;
  pendingUpdates: number;
} {
  const lastSyncSetting = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('tmdb_last_sync_date') as { value: string } | undefined;

  const totalCached = (db.prepare('SELECT COUNT(*) as count FROM tmdb_movie_cache WHERE is_deleted = 0').get() as { count: number }).count;
  const pendingUpdates = (db.prepare('SELECT COUNT(*) as count FROM radarr_movies WHERE tmdb_id IS NOT NULL AND tmdb_id NOT IN (SELECT tmdb_id FROM tmdb_movie_cache WHERE is_deleted = 0)').get() as { count: number }).count;

  // Parse date like other sync functions do (returns Date | null)
  // Handle both old format (SQLite datetime without timezone) and new format (ISO string)
  let lastSyncDate: Date | null = null;
  if (lastSyncSetting?.value) {
    const value = lastSyncSetting.value;
    // If it's already an ISO string (has 'T' and 'Z'), parse directly
    if (value.includes('T') && value.includes('Z')) {
      lastSyncDate = new Date(value);
    } else if (value.includes('T')) {
      // Has 'T' but no 'Z' - assume UTC and add 'Z'
      lastSyncDate = new Date(value.endsWith('Z') ? value : value + 'Z');
    } else {
      // Old SQLite format: "YYYY-MM-DD HH:MM:SS" - treat as UTC by adding 'Z'
      lastSyncDate = new Date(value.replace(' ', 'T') + 'Z');
    }
  }

  return {
    lastSyncDate,
    totalCached,
    pendingUpdates,
  };
}

