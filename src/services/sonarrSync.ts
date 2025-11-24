import db from '../db';
import sonarrClient from '../sonarr/client';
import { syncProgress } from './syncProgress';

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

  try {
    console.log('Starting Sonarr shows sync...');
    syncProgress.start('sonarr', 0);
    syncProgress.update('Connecting to Sonarr...', 0);
    
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
      syncProgress.complete();
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
    const settingsModel = (await import('../models/settings')).settingsModel;
    settingsModel.set('sonarr_last_sync', new Date().toISOString());

    console.log(`Sonarr sync completed: ${stats.synced} new, ${stats.updated} updated, ${stats.errors.length} errors`);
    syncProgress.complete();

    return stats;
  } catch (error: any) {
    console.error('Sonarr sync error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    syncProgress.error(`Sonarr sync failed: ${errorMessage}`);
    throw error;
  }
}

export function getSyncedSonarrShows() {
  const rows = db.prepare('SELECT * FROM sonarr_shows ORDER BY title').all() as any[];
  return rows.map((row) => ({
    ...row,
    monitored: Boolean(row.monitored),
    seasons: row.seasons ? JSON.parse(row.seasons) : null,
    images: row.images ? JSON.parse(row.images) : null,
  }));
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

export function getLastSonarrSync(): Date | null {
  const { settingsModel } = require('../models/settings');
  const lastSync = settingsModel.get('sonarr_last_sync');
  return lastSync ? new Date(lastSync) : null;
}

