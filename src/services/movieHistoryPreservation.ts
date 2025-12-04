import db from '../db';
import { RadarrClient } from '../radarr/client';
import { RadarrHistory } from '../radarr/types';

/**
 * Preserve movie history before deletion
 * Stores history in local database for future reference
 */
export async function preserveMovieHistory(radarrId: number): Promise<void> {
  const radarrClient = new RadarrClient();
  
  // Get movie info
  const movie = await radarrClient.getMovie(radarrId);
  if (!movie) {
    throw new Error(`Movie with Radarr ID ${radarrId} not found`);
  }

  // Get history
  const history = await radarrClient.getMovieHistory(radarrId);

  // Store in database
  db.prepare(`
    INSERT INTO radarr_movie_history (radarr_id, tmdb_id, title, history_data)
    VALUES (?, ?, ?, ?)
  `).run(
    radarrId,
    movie.tmdbId || null,
    movie.title || null,
    JSON.stringify(history)
  );
}

/**
 * Get preserved history for a movie
 */
export function getPreservedHistory(radarrId: number): RadarrHistory[] | null {
  const row = db.prepare(`
    SELECT history_data FROM radarr_movie_history
    WHERE radarr_id = ?
    ORDER BY preserved_at DESC
    LIMIT 1
  `).get(radarrId) as { history_data: string } | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.history_data) as RadarrHistory[];
  } catch (error) {
    console.error('Error parsing preserved history:', error);
    return null;
  }
}

/**
 * Mark history as restored (for future use)
 */
export function markHistoryRestored(radarrId: number, restoredToRadarrId: number): void {
  db.prepare(`
    UPDATE radarr_movie_history
    SET restored_to_radarr_id = ?, restored_at = datetime('now')
    WHERE radarr_id = ?
  `).run(restoredToRadarrId, radarrId);
}

