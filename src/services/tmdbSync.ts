import db from '../db';
import { TMDBClient, TMDBMovie } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { syncProgress } from './syncProgress';

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
 */
export async function initialTmdbSync(): Promise<TmdbSyncStats> {
  const stats: TmdbSyncStats = {
    totalMovies: 0,
    moviesSynced: 0,
    moviesUpdated: 0,
    moviesDeleted: 0,
    errors: [],
    lastSyncAt: null,
  };

  try {
    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      stats.errors.push('TMDB API key not configured');
      return stats;
    }

    tmdbClient.setApiKey(tmdbApiKey);

    // Get all unique tmdb_ids from radarr_movies
    const movies = db
      .prepare(`
        SELECT DISTINCT tmdb_id
        FROM radarr_movies
        WHERE tmdb_id IS NOT NULL
        ORDER BY tmdb_id
      `)
      .all() as Array<{ tmdb_id: number }>;

    stats.totalMovies = movies.length;

    if (stats.totalMovies === 0) {
      return stats;
    }

    syncProgress.start('tmdb-sync', 0);
    syncProgress.update(`Starting TMDB sync for ${stats.totalMovies} movies...`, 0, stats.totalMovies);

    const BATCH_SIZE = 50;
    const RATE_LIMIT_DELAY = 350; // 350ms = ~3 requests/second

    for (let i = 0; i < movies.length; i += BATCH_SIZE) {
      const batch = movies.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(movies.length / BATCH_SIZE);

      syncProgress.update(
        `Processing batch ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + BATCH_SIZE, movies.length)} of ${movies.length})...`,
        stats.moviesSynced + stats.moviesDeleted,
        movies.length
      );

      for (const movie of batch) {
        try {
          const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);

          if (!tmdbMovie) {
            // Movie not found - mark as deleted
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

          stats.moviesSynced++;
        } catch (error: any) {
          const errorMsg = `Failed to sync TMDB ID ${movie.tmdb_id}: ${error?.message || 'Unknown error'}`;
          stats.errors.push(errorMsg);
          console.error(errorMsg, error);
        }

        // Rate limit: wait between requests
        if (i + batch.indexOf(movie) < movies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }
      }
    }

    // Update last sync date
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value)
      VALUES ('tmdb_last_sync_date', date('now'))
    `).run();

    stats.lastSyncAt = new Date();
    syncProgress.complete();
  } catch (error: any) {
    stats.errors.push(`Sync failed: ${error?.message || 'Unknown error'}`);
    console.error('TMDB initial sync error:', error);
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

  try {
    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      stats.errors.push('TMDB API key not configured');
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
      console.log('No previous TMDB sync found, running initial sync...');
      return await initialTmdbSync();
    }

    // Get changed movie IDs from TMDB
    syncProgress.start('tmdb-sync', 0);
    syncProgress.update('Fetching list of changed movies from TMDB...', 0);

    const changedIds = await tmdbClient.getMovieChanges(lastSyncDate, today);
    stats.totalMovies = changedIds.length;

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
      syncProgress.complete();
      // Still update sync date
      db.prepare(`
        INSERT OR REPLACE INTO app_settings (key, value)
        VALUES ('tmdb_last_sync_date', date('now'))
      `).run();
      stats.lastSyncAt = new Date();
      return stats;
    }

    syncProgress.update(`Updating ${relevantChangedIds.length} movies...`, 0, relevantChangedIds.length);

    const RATE_LIMIT_DELAY = 350; // 350ms = ~3 requests/second

    for (let i = 0; i < relevantChangedIds.length; i++) {
      const tmdbId = relevantChangedIds[i];

      try {
        const tmdbMovie = await tmdbClient.getMovie(tmdbId);

        if (!tmdbMovie) {
          // Movie deleted from TMDB
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
            stats.moviesUpdated++;
          } else {
            // New movie (shouldn't happen in incremental, but handle it)
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
          console.warn(`Rate limited, waiting ${retryAfter} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          // Retry this movie
          i--;
          continue;
        }

        const errorMsg = `Failed to sync TMDB ID ${tmdbId}: ${error?.message || 'Unknown error'}`;
        stats.errors.push(errorMsg);
        console.error(errorMsg, error);
      }
    }

    // Update last sync date
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value)
      VALUES ('tmdb_last_sync_date', date('now'))
    `).run();

    stats.lastSyncAt = new Date();
    syncProgress.complete();
  } catch (error: any) {
    stats.errors.push(`Incremental sync failed: ${error?.message || 'Unknown error'}`);
    console.error('TMDB incremental sync error:', error);
    syncProgress.complete();
  }

  return stats;
}

/**
 * Get sync status
 */
export function getTmdbSyncStatus(): {
  lastSyncDate: string | null;
  totalCached: number;
  pendingUpdates: number;
} {
  const lastSyncSetting = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('tmdb_last_sync_date') as { value: string } | undefined;

  const totalCached = (db.prepare('SELECT COUNT(*) as count FROM tmdb_movie_cache WHERE is_deleted = 0').get() as { count: number }).count;
  const pendingUpdates = (db.prepare('SELECT COUNT(*) as count FROM radarr_movies WHERE tmdb_id IS NOT NULL AND tmdb_id NOT IN (SELECT tmdb_id FROM tmdb_movie_cache WHERE is_deleted = 0)').get() as { count: number }).count;

  return {
    lastSyncDate: lastSyncSetting?.value || null,
    totalCached,
    pendingUpdates,
  };
}

