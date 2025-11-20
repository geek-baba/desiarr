import db from '../db';
import radarrClient from '../radarr/client';
import { RadarrMovie } from '../radarr/types';
import { syncProgress } from './syncProgress';

export interface RadarrSyncStats {
  totalMovies: number;
  synced: number;
  updated: number;
  errors: Array<{ movieId: number; title: string; error: string }>;
  lastSyncAt: Date;
}

/**
 * Sync all movies from Radarr and store in radarr_movies table
 */
export async function syncRadarrMovies(): Promise<RadarrSyncStats> {
  const stats: RadarrSyncStats = {
    totalMovies: 0,
    synced: 0,
    updated: 0,
    errors: [],
    lastSyncAt: new Date(),
  };

  try {
    console.log('Starting Radarr movies sync...');
    syncProgress.start('radarr', 0);
    syncProgress.update('Fetching movies from Radarr...', 0);
    
    const movies = await radarrClient.getAllMovies();
    stats.totalMovies = movies.length;

    console.log(`Found ${movies.length} movies in Radarr`);
    
    if (movies.length === 0) {
      syncProgress.update('No movies found in Radarr', 0, 0);
      syncProgress.complete();
      return stats;
    }
    
    syncProgress.update('Processing movies...', 0, movies.length);

    // Use transaction for better performance
    const transaction = db.transaction(() => {
      let processed = 0;
      for (const movie of movies) {
        try {
          if (!movie.id) {
            continue; // Skip movies without ID
          }

          processed++;
          if (processed % 10 === 0 || processed === movies.length) {
            syncProgress.update(`Processing movies... (${processed}/${movies.length})`, processed, movies.length, stats.errors.length);
          }

          // Check if movie already exists
          const existing = db
            .prepare('SELECT id FROM radarr_movies WHERE radarr_id = ?')
            .get(movie.id) as { id: number } | undefined;

          const movieData = {
            radarr_id: movie.id,
            tmdb_id: movie.tmdbId,
            imdb_id: movie.imdbId || null,
            title: movie.title,
            year: movie.year || null,
            path: movie.path || null,
            has_file: movie.hasFile ? 1 : 0,
            movie_file: movie.movieFile ? JSON.stringify(movie.movieFile) : null,
            original_language: movie.originalLanguage?.name || null,
            images: movie.images ? JSON.stringify(movie.images) : null,
            synced_at: new Date().toISOString(),
          };

          if (existing) {
            // Update existing
            db.prepare(`
              UPDATE radarr_movies SET
                tmdb_id = ?,
                imdb_id = ?,
                title = ?,
                year = ?,
                path = ?,
                has_file = ?,
                movie_file = ?,
                original_language = ?,
                images = ?,
                synced_at = ?
              WHERE radarr_id = ?
            `).run(
              movieData.tmdb_id,
              movieData.imdb_id,
              movieData.title,
              movieData.year,
              movieData.path,
              movieData.has_file,
              movieData.movie_file,
              movieData.original_language,
              movieData.images,
              movieData.synced_at,
              movie.id
            );
            stats.updated++;
          } else {
            // Insert new
            db.prepare(`
              INSERT INTO radarr_movies (
                radarr_id, tmdb_id, imdb_id, title, year, path, has_file,
                movie_file, original_language, images, synced_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              movieData.radarr_id,
              movieData.tmdb_id,
              movieData.imdb_id,
              movieData.title,
              movieData.year,
              movieData.path,
              movieData.has_file,
              movieData.movie_file,
              movieData.original_language,
              movieData.images,
              movieData.synced_at
            );
            stats.synced++;
          }
        } catch (error: any) {
          stats.errors.push({
            movieId: movie.id || 0,
            title: movie.title,
            error: error?.message || 'Unknown error',
          });
          console.error(`Error syncing movie ${movie.id} (${movie.title}):`, error);
        }
      }
    });

    transaction();

    // Update last sync timestamp
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('radarr_last_sync', ?)").run(
      stats.lastSyncAt.toISOString()
    );

    syncProgress.update('Sync completed', stats.totalMovies, stats.totalMovies, stats.errors.length);
    syncProgress.complete();
    
    console.log(`Radarr sync completed: ${stats.synced} new, ${stats.updated} updated, ${stats.errors.length} errors`);
    return stats;
  } catch (error: any) {
    console.error('Radarr sync error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
    syncProgress.complete();
    throw error;
  }
}

/**
 * Get all synced Radarr movies
 */
export function getSyncedRadarrMovies(): any[] {
  return db.prepare('SELECT * FROM radarr_movies ORDER BY title').all();
}

/**
 * Get synced Radarr movie by TMDB ID
 */
export function getSyncedRadarrMovieByTmdbId(tmdbId: number): any | null {
  return db.prepare('SELECT * FROM radarr_movies WHERE tmdb_id = ?').get(tmdbId) || null;
}

/**
 * Get synced Radarr movie by Radarr ID
 */
export function getSyncedRadarrMovieByRadarrId(radarrId: number): any | null {
  return db.prepare('SELECT * FROM radarr_movies WHERE radarr_id = ?').get(radarrId) || null;
}

/**
 * Get last sync timestamp
 */
export function getLastRadarrSync(): Date | null {
  const result = db.prepare("SELECT value FROM app_settings WHERE key = 'radarr_last_sync'").get() as { value: string } | undefined;
  return result ? new Date(result.value) : null;
}

