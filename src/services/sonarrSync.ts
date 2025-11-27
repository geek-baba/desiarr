import db from '../db';
import sonarrClient from '../sonarr/client';
import { syncProgress } from './syncProgress';
import { settingsModel } from '../models/settings';

export interface SonarrSyncStats {
  totalShows: number;
  synced: number;
  updated: number;
  errors: Array<{ seriesId: number; title: string; error: string }>;
  lastSyncAt: Date;
}

interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  path?: string;
  monitored: boolean;
  tvdbId?: number;
  tvMazeId?: number;
  imdbId?: string;
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>;
  images?: Array<{ coverType: string; url: string }>;
  added?: string;
  dateAdded?: string;
}

/**
 * Sync all TV shows from Sonarr and store in sonarr_shows table
 */
export async function syncSonarrShows(): Promise<SonarrSyncStats> {
  const stats: SonarrSyncStats = {
    totalShows: 0,
    synced: 0,
    updated: 0,
    errors: [],
    lastSyncAt: new Date(),
  };

  const parentProgress = syncProgress.get();
  const nestedInFullSync = Boolean(parentProgress && parentProgress.isRunning && parentProgress.type === 'full');

  try {
    console.log('Starting Sonarr shows sync...');
    if (!nestedInFullSync) {
      syncProgress.start('sonarr', 0);
      syncProgress.update('Connecting to Sonarr...', 0);
    }
    
    // Update client config in case it changed
    console.log('Updating Sonarr client configuration...');
    sonarrClient.updateConfig();
    
    syncProgress.update('Fetching shows from Sonarr API...', 0);
    console.log('Calling getSeries()...');
    
    let series: SonarrSeries[];
    try {
      series = await sonarrClient.getSeries();
      console.log(`getSeries() returned ${series?.length || 0} shows`);
    } catch (error: any) {
      console.error('Error in getSeries():', error);
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      throw new Error(`Failed to fetch shows: ${errorMessage}`);
    }
    
    stats.totalShows = series.length;

    console.log(`Found ${series.length} shows in Sonarr`);
    
    if (series.length === 0) {
      syncProgress.update('No shows found in Sonarr (this might be normal if your Sonarr library is empty)', 0, 0);
      if (!nestedInFullSync) {
        syncProgress.complete();
      }
      return stats;
    }
    
    syncProgress.update('Processing shows...', 0, series.length);

    // Track new shows for progress details
    const newShows: string[] = [];

    // Use transaction for better performance
    const transaction = db.transaction(() => {
      let processed = 0;
      for (const show of series) {
        try {
          if (!show.id) {
            continue; // Skip shows without ID
          }

          processed++;
          if (processed % 10 === 0 || processed === series.length) {
            syncProgress.update(`Processing shows... (${processed}/${series.length})`, processed, series.length, stats.errors.length);
          }

          // Check if show already exists
          const existing = db
            .prepare('SELECT id FROM sonarr_shows WHERE sonarr_id = ?')
            .get(show.id) as { id: number } | undefined;

          // Sonarr API returns 'added' field (not 'dateAdded'), handle both for compatibility
          const dateAdded = (show as any).added || (show as any).dateAdded || show.dateAdded || null;
          
          // Extract seasons data
          const seasonsData = show.seasons ? JSON.stringify(show.seasons) : null;
          
          const showData = {
            sonarr_id: show.id,
            tvdb_id: show.tvdbId || null,
            tmdb_id: (show as any).tmdbId || null, // Sonarr may have TMDB ID
            imdb_id: show.imdbId || null,
            title: show.title,
            year: show.year || null,
            path: show.path || null,
            monitored: show.monitored ? 1 : 0,
            seasons: seasonsData,
            images: show.images ? JSON.stringify(show.images) : null,
            date_added: dateAdded,
            synced_at: new Date().toISOString(),
          };

          if (existing) {
            // Update existing show
            db.prepare(`
              UPDATE sonarr_shows SET
                tvdb_id = ?,
                tmdb_id = ?,
                imdb_id = ?,
                title = ?,
                year = ?,
                path = ?,
                monitored = ?,
                seasons = ?,
                images = ?,
                date_added = ?,
                synced_at = ?,
                updated_at = datetime('now')
              WHERE sonarr_id = ?
            `).run(
              showData.tvdb_id,
              showData.tmdb_id,
              showData.imdb_id,
              showData.title,
              showData.year,
              showData.path,
              showData.monitored,
              showData.seasons,
              showData.images,
              showData.date_added,
              showData.synced_at,
              show.id
            );
            stats.updated++;
          } else {
            // Insert new show
            db.prepare(`
              INSERT INTO sonarr_shows (
                sonarr_id, tvdb_id, tmdb_id, imdb_id, title, year, path,
                monitored, seasons, images, date_added, synced_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              showData.sonarr_id,
              showData.tvdb_id,
              showData.tmdb_id,
              showData.imdb_id,
              showData.title,
              showData.year,
              showData.path,
              showData.monitored,
              showData.seasons,
              showData.images,
              showData.date_added,
              showData.synced_at
            );
            stats.synced++;
            newShows.push(show.title);
          }
        } catch (error: any) {
          console.error(`Error processing show ${show.id} (${show.title}):`, error);
          stats.errors.push({
            seriesId: show.id,
            title: show.title,
            error: error?.message || error?.toString() || 'Unknown error',
          });
        }
      }
    });

    transaction();

    // Update progress with details
    const details: string[] = [];
    if (newShows.length > 0) {
      details.push(`${newShows.length} new show(s) added: ${newShows.slice(0, 5).join(', ')}${newShows.length > 5 ? '...' : ''}`);
    }
    if (stats.updated > 0) {
      details.push(`${stats.updated} show(s) updated`);
    }
    if (stats.errors.length > 0) {
      details.push(`${stats.errors.length} error(s)`);
    }

    syncProgress.update(
      `Completed: ${stats.synced} new, ${stats.updated} updated`,
      series.length,
      series.length,
      stats.errors.length,
      details
    );

    // Save last sync time
    settingsModel.set('sonarr_last_sync', new Date().toISOString());

    console.log(`Sonarr sync completed: ${stats.synced} new, ${stats.updated} updated, ${stats.errors.length} errors`);
    if (!nestedInFullSync) {
      syncProgress.complete();
    }

    return stats;
  } catch (error: any) {
    console.error('Sonarr sync error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    if (!nestedInFullSync) {
      syncProgress.error(`Sonarr sync failed: ${errorMessage}`);
    }
    throw error;
  }
}

export function getSyncedSonarrShowByTvdbId(tvdbId: number) {
  const row = db.prepare('SELECT * FROM sonarr_shows WHERE tvdb_id = ?').get(tvdbId) as any;
  if (!row) return null;
  return {
    ...row,
    monitored: Boolean(row.monitored),
    seasons: row.seasons ? JSON.parse(row.seasons) : null,
    images: row.images ? JSON.parse(row.images) : null,
  };
}

export function getSyncedSonarrShowBySonarrId(sonarrId: number) {
  const row = db.prepare('SELECT * FROM sonarr_shows WHERE sonarr_id = ?').get(sonarrId) as any;
  if (!row) return null;
  return {
    ...row,
    monitored: Boolean(row.monitored),
    seasons: row.seasons ? JSON.parse(row.seasons) : null,
    images: row.images ? JSON.parse(row.images) : null,
  };
}

/**
 * Search Sonarr shows by name (fuzzy match, case-insensitive, ignores year)
 * Returns the best match or null
 */
export function findSonarrShowByName(showName: string): any | null {
  if (!showName || !showName.trim()) return null;
  
  // Normalize search term: lowercase, remove year patterns, trim
  let normalizedSearch = showName.toLowerCase().trim();
  normalizedSearch = normalizedSearch
    .replace(/\s*\((\d{4})\)\s*/g, ' ') // Remove (2025)
    .replace(/\s*\[(\d{4})\]\s*/g, ' ') // Remove [2025]
    .replace(/\s+(\d{4})\s+/g, ' ') // Remove standalone 2025
    .replace(/\s+(\d{4})$/g, '') // Remove year at end
    .replace(/^(\d{4})\s+/g, '') // Remove year at start
    .replace(/\s+/g, ' ')
    .trim();
  
  // Get all Sonarr shows
  const allShows = db.prepare('SELECT * FROM sonarr_shows').all() as any[];
  
  if (allShows.length === 0) return null;
  
  // Normalize all show titles (remove years for comparison)
  const normalizedShows = allShows.map(show => {
    if (!show.title) return null;
    let normalizedTitle = show.title.toLowerCase().trim();
    normalizedTitle = normalizedTitle
      .replace(/\s*\((\d{4})\)\s*/g, ' ') // Remove (2019)
      .replace(/\s*\[(\d{4})\]\s*/g, ' ') // Remove [2019]
      .replace(/\s+(\d{4})\s+/g, ' ') // Remove standalone year
      .replace(/\s+(\d{4})$/g, '') // Remove year at end
      .replace(/^(\d{4})\s+/g, '') // Remove year at start
      .replace(/\s+/g, ' ')
      .trim();
    return { ...show, normalizedTitle };
  }).filter(Boolean);
  
  // Try exact match first (case-insensitive, year-agnostic)
  let match = normalizedShows.find(show => 
    show.normalizedTitle === normalizedSearch
  );
  
  if (match) {
    return {
      ...match,
      monitored: Boolean(match.monitored),
      seasons: match.seasons ? JSON.parse(match.seasons) : null,
      images: match.images ? JSON.parse(match.images) : null,
    };
  }
  
  // Try fuzzy match - show name contains search term or vice versa (year-agnostic)
  match = normalizedShows.find(show => {
    return show.normalizedTitle.includes(normalizedSearch) || 
           normalizedSearch.includes(show.normalizedTitle);
  });
  
  if (match) {
    return {
      ...match,
      monitored: Boolean(match.monitored),
      seasons: match.seasons ? JSON.parse(match.seasons) : null,
      images: match.images ? JSON.parse(match.images) : null,
    };
  }
  
  return null;
}

/**
 * Get all synced Sonarr shows with pagination
 */
export function getSyncedSonarrShows(page: number = 1, limit: number = 50, search?: string): { shows: any[]; total: number } {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM sonarr_shows';
  let countQuery = 'SELECT COUNT(*) as count FROM sonarr_shows';
  const params: any[] = [];
  
  if (search && search.trim()) {
    const searchTerm = `%${search.trim()}%`;
    query += ' WHERE title LIKE ? OR tvdb_id LIKE ? OR tmdb_id LIKE ? OR imdb_id LIKE ? OR year LIKE ?';
    countQuery += ' WHERE title LIKE ? OR tvdb_id LIKE ? OR tmdb_id LIKE ? OR imdb_id LIKE ? OR year LIKE ?';
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }
  
  // Sort by date_added DESC (newest first), fallback to title if date_added is null
  query += ' ORDER BY datetime(date_added) DESC, title ASC';
  query += ` LIMIT ? OFFSET ?`;
  
  const rows = db.prepare(query).all(...params, limit, offset) as any[];
  const shows = rows.map(row => ({
    ...row,
    monitored: Boolean(row.monitored),
    seasons: row.seasons ? JSON.parse(row.seasons) : null,
    images: row.images ? JSON.parse(row.images) : null,
  }));
  
  const totalResult = db.prepare(countQuery).get(...params) as { count: number };
  
  return {
    shows,
    total: totalResult.count,
  };
}

export function getLastSonarrSync(): Date | null {
  const lastSync = settingsModel.get('sonarr_last_sync');
  return lastSync ? new Date(lastSync) : null;
}

