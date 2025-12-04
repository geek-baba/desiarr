import db from '../db';
import radarrClient from '../radarr/client';
import { RadarrMovie } from '../radarr/types';
import { syncProgress } from './syncProgress';
import { getLanguageName, isIndianLanguage } from '../utils/languageMapping';

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
  const parentProgress = syncProgress.get();
  const nestedInFullSync = Boolean(parentProgress && parentProgress.isRunning && parentProgress.type === 'full');

  try {
    console.log('Starting Radarr movies sync...');
    if (!nestedInFullSync) {
      syncProgress.start('radarr', 0);
      syncProgress.update('Connecting to Radarr...', 0);
    }
    
    // Update client config in case it changed
    console.log('Updating Radarr client configuration...');
    radarrClient.updateConfig();
    
    syncProgress.update('Fetching movies from Radarr API...', 0);
    console.log('Calling getAllMovies()...');
    
    let movies: RadarrMovie[];
    try {
      movies = await radarrClient.getAllMovies();
      console.log(`getAllMovies() returned ${movies?.length || 0} movies`);
    } catch (error: any) {
      console.error('Error in getAllMovies():', error);
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      throw new Error(`Failed to fetch movies: ${errorMessage}`);
    }
    
    stats.totalMovies = movies.length;

    console.log(`Found ${movies.length} movies in Radarr`);
    
    // Get all current radarr_ids from local database to identify deleted movies
    const existingRadarrIds = db
      .prepare('SELECT radarr_id FROM radarr_movies')
      .all() as Array<{ radarr_id: number }>;
    const existingRadarrIdSet = new Set(existingRadarrIds.map(m => m.radarr_id));
    
    // Get all radarr_ids from the current Radarr response
    const currentRadarrIdSet = new Set(movies.map(m => m.id).filter((id): id is number => id !== undefined));
    
    // Find movies that are in local DB but not in Radarr (deleted from Radarr)
    const deletedRadarrIds = existingRadarrIds
      .map(m => m.radarr_id)
      .filter(id => !currentRadarrIdSet.has(id));
    
    if (movies.length === 0) {
      syncProgress.update('No movies found in Radarr (this might be normal if your Radarr library is empty)', 0, 0);
      // If Radarr is empty, remove all movies from local DB
      if (existingRadarrIds.length > 0) {
        console.log(`Radarr is empty, removing all ${existingRadarrIds.length} movies from local database`);
        db.prepare('DELETE FROM radarr_movies').run();
        stats.updated = existingRadarrIds.length; // Track as "updated" for stats
      }
      if (!nestedInFullSync) {
        syncProgress.complete();
      }
      return stats;
    }
    
    syncProgress.update('Processing movies...', 0, movies.length);

    // Track new movies for progress details
    const newMovies: string[] = [];

    // Use transaction for better performance
    const transaction = db.transaction(() => {
      // First, remove movies that have been deleted from Radarr
      if (deletedRadarrIds.length > 0) {
        console.log(`Removing ${deletedRadarrIds.length} movie(s) that were deleted from Radarr: ${deletedRadarrIds.join(', ')}`);
        const placeholders = deletedRadarrIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM radarr_movies WHERE radarr_id IN (${placeholders})`).run(...deletedRadarrIds);
        stats.updated += deletedRadarrIds.length; // Track deletions as "updated" for stats
      }
      
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

          // Radarr API returns 'added' field (not 'dateAdded'), handle both for compatibility
          const dateAdded = (movie as any).added || (movie as any).dateAdded || movie.dateAdded || null;
          
          // Check if Radarr has wrong language compared to TMDB
          let finalLanguage = movie.originalLanguage?.name || null;
          let languageFixedInRadarr = false;
          
          if (movie.tmdbId && finalLanguage) {
            const tmdbData = db.prepare('SELECT original_language FROM tmdb_movie_cache WHERE tmdb_id = ?')
              .get(movie.tmdbId) as { original_language: string | null } | undefined;
            
            if (tmdbData?.original_language && isIndianLanguage(tmdbData.original_language)) {
              const tmdbLanguageName = getLanguageName(tmdbData.original_language);
              
              // If Radarr has wrong language and TMDB has correct Indian language, fix it
              if (tmdbLanguageName && tmdbLanguageName !== finalLanguage) {
                console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Radarr has "${finalLanguage}" but TMDB has "${tmdbLanguageName}" - fixing in Radarr...`);
                
                try {
                  // Get correct language from Radarr's language list
                  const radarrLanguages = await radarrClient.getLanguages();
                  const correctLanguage = radarrLanguages.find(
                    lang => lang.name.toLowerCase() === tmdbLanguageName.toLowerCase()
                  );
                  
                  if (correctLanguage) {
                    // Update Radarr's originalLanguage directly via API
                    await radarrClient.updateMovie(movie.id, {
                      originalLanguage: correctLanguage,
                    });
                    
                    console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Successfully updated Radarr originalLanguage to "${tmdbLanguageName}"`);
                    finalLanguage = tmdbLanguageName;
                    languageFixedInRadarr = true;
                  } else {
                    console.warn(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Language "${tmdbLanguageName}" not found in Radarr's language list, cannot fix`);
                  }
                } catch (updateError: any) {
                  console.error(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Failed to update Radarr language:`, updateError?.message || updateError);
                }
              }
            }
          }
          
          const movieData = {
            radarr_id: movie.id,
            tmdb_id: movie.tmdbId,
            imdb_id: movie.imdbId || null,
            title: movie.title,
            year: movie.year || null,
            path: movie.path || null,
            has_file: movie.hasFile ? 1 : 0,
            movie_file: movie.movieFile ? JSON.stringify(movie.movieFile) : null,
            original_language: finalLanguage, // Use corrected language if we fixed it
            images: movie.images ? JSON.stringify(movie.images) : null,
            date_added: dateAdded,
            synced_at: new Date().toISOString(),
          };

          // Log what Radarr API is returning for debugging
          if (movie.id === 3384 || (movie.title && movie.title.toLowerCase().includes('aakhri'))) {
            console.log(`[Radarr Sync] DEBUG Movie ${movie.id} (${movie.title}):`);
            console.log(`  - Radarr API originalLanguage: ${JSON.stringify(movie.originalLanguage)}`);
            console.log(`  - movieData.original_language: ${movieData.original_language}`);
            console.log(`  - TMDB ID: ${movie.tmdbId}`);
          }

          if (existing) {
            // Update existing (preserve date_added if not provided)
            const existingMovie = db.prepare('SELECT date_added, original_language FROM radarr_movies WHERE radarr_id = ?').get(movie.id) as { date_added: string | null; original_language: string | null } | undefined;
            const dateAdded = movieData.date_added || existingMovie?.date_added || null;
            
            // Log language changes for debugging
            const oldLanguage = existingMovie?.original_language || null;
            const newLanguage = movieData.original_language || null;
            if (oldLanguage !== newLanguage) {
              console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Language changed from "${oldLanguage}" to "${newLanguage}"`);
            } else if (movie.id === 3384 || (movie.title && movie.title.toLowerCase().includes('aakhri'))) {
              console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Language unchanged - DB="${oldLanguage}", Radarr="${newLanguage}"`);
            }
            
            const updateStmt = db.prepare(`
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
                date_added = ?,
                synced_at = ?
              WHERE radarr_id = ?
            `);
            
            const result = updateStmt.run(
              movieData.tmdb_id,
              movieData.imdb_id,
              movieData.title,
              movieData.year,
              movieData.path,
              movieData.has_file,
              movieData.movie_file,
              movieData.original_language,
              movieData.images,
              dateAdded,
              movieData.synced_at,
              movie.id
            );
            
            // Verify the update actually changed rows
            if (result.changes === 0) {
              console.warn(`[Radarr Sync] Movie ${movie.id} (${movie.title}): UPDATE statement affected 0 rows - this might indicate a problem`);
            } else if (movie.id === 3384 || (movie.title && movie.title.toLowerCase().includes('aakhri'))) {
              console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): UPDATE successful - ${result.changes} row(s) changed`);
              // Verify the update by reading back from DB
              const verify = db.prepare('SELECT original_language FROM radarr_movies WHERE radarr_id = ?').get(movie.id) as { original_language: string | null } | undefined;
              console.log(`[Radarr Sync] Movie ${movie.id} (${movie.title}): Verification - DB now has original_language="${verify?.original_language || 'NULL'}"`);
            }
            
            stats.updated++;
          } else {
            // Insert new
            db.prepare(`
              INSERT INTO radarr_movies (
                radarr_id, tmdb_id, imdb_id, title, year, path, has_file,
                movie_file, original_language, images, date_added, synced_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              movieData.date_added, // Added missing date_added parameter
              movieData.synced_at
            );
            stats.synced++;
            // Track new movies (limit to first 5 for display)
            if (newMovies.length < 5) {
              const displayTitle = movie.title || 'Unknown';
              newMovies.push(displayTitle);
            }
          }
        } catch (error: any) {
          // Build detailed error message
          let errorMessage = 'Unknown error';
          if (error?.message) {
            errorMessage = error.message;
          } else if (typeof error === 'string') {
            errorMessage = error;
          } else if (error?.toString) {
            errorMessage = error.toString();
          }
          
          // Log full error details
          console.error(`Error syncing movie ${movie.id} (${movie.title}):`, {
            error: errorMessage,
            errorType: error?.constructor?.name || typeof error,
            stack: error?.stack,
            movieData: {
              radarr_id: movie.id,
              tmdb_id: movie.tmdbId,
              imdb_id: movie.imdbId,
              title: movie.title,
              year: movie.year,
              hasFile: movie.hasFile,
              hasMovieFile: !!movie.movieFile,
              hasImages: !!movie.images,
            },
            rawError: error,
          });
          
          stats.errors.push({
            movieId: movie.id || 0,
            title: movie.title,
            error: errorMessage,
          });
        }
      }
    });

    transaction();

    // Update last sync timestamp (use current time, not the start time)
    const syncCompleteTime = new Date();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('radarr_last_sync', ?)").run(
      syncCompleteTime.toISOString()
    );
    stats.lastSyncAt = syncCompleteTime;

    // Build progress details
    const details: string[] = [];
    if (stats.synced > 0) {
      if (newMovies.length > 0) {
        const moviesList = newMovies.join(', ');
        const moreText = stats.synced > newMovies.length ? ` (+${stats.synced - newMovies.length} more)` : '';
        details.push(`${stats.synced} new movie${stats.synced > 1 ? 's' : ''}: ${moviesList}${moreText}`);
      } else {
        details.push(`${stats.synced} new movie${stats.synced > 1 ? 's' : ''} synced`);
      }
    }
    if (stats.updated > 0) {
      details.push(`${stats.updated} movie${stats.updated > 1 ? 's' : ''} updated`);
    }
    
    syncProgress.update(
      'Radarr sync completed', 
      stats.totalMovies, 
      stats.totalMovies, 
      stats.errors.length,
      details.length > 0 ? details : undefined
    );
    if (!nestedInFullSync) {
      syncProgress.complete();
    }
    
    console.log(`Radarr sync completed: ${stats.synced} new, ${stats.updated} updated, ${stats.errors.length} errors`);
    return stats;
  } catch (error: any) {
    console.error('Radarr sync error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    syncProgress.update(`Error: ${errorMessage}`, 0, 0, 1);
    if (!nestedInFullSync) {
      syncProgress.complete();
    }
    throw error;
  }
}

/**
 * Get all synced Radarr movies
 */
export function getSyncedRadarrMovies(page: number = 1, limit: number = 50, search?: string): { movies: any[]; total: number } {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM radarr_movies';
  let countQuery = 'SELECT COUNT(*) as count FROM radarr_movies';
  const params: any[] = [];
  
  if (search && search.trim()) {
    const searchTerm = `%${search.trim()}%`;
    query += ' WHERE title LIKE ? OR tmdb_id LIKE ? OR imdb_id LIKE ? OR year LIKE ?';
    countQuery += ' WHERE title LIKE ? OR tmdb_id LIKE ? OR imdb_id LIKE ? OR year LIKE ?';
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }
  
  // Sort by date_added DESC (newest first), fallback to title if date_added is null
  query += ' ORDER BY datetime(date_added) DESC, title ASC';
  query += ` LIMIT ? OFFSET ?`;
  
  const movies = db.prepare(query).all(...params, limit, offset);
  const totalResult = db.prepare(countQuery).get(...params) as { count: number };
  
  return {
    movies,
    total: totalResult.count,
  };
}

/**
 * Get synced Radarr movie by TMDB ID
 */
export function getSyncedRadarrMovieByTmdbId(tmdbId: number): any | null {
  const result = db.prepare('SELECT * FROM radarr_movies WHERE tmdb_id = ?').get(tmdbId);
  if (!result) {
    // Debug: Check how many movies are in the table and what TMDB IDs exist
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM radarr_movies').get() as { count: number };
    console.log(`  [DEBUG] No Radarr movie found for TMDB ID ${tmdbId}. Total movies in radarr_movies table: ${totalCount.count}`);
    
    // Show some sample TMDB IDs from the database for debugging
    const sampleMovies = db.prepare('SELECT tmdb_id, title FROM radarr_movies LIMIT 10').all() as Array<{ tmdb_id: number; title: string }>;
    if (sampleMovies.length > 0) {
      console.log(`  [DEBUG] Sample TMDB IDs in database: ${sampleMovies.map(m => `${m.tmdb_id} (${m.title})`).join(', ')}`);
    }
  }
  return result || null;
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

