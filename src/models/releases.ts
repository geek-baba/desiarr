import db from '../db';
import { MovieRelease, ReleaseStatus } from '../types/Release';

function convertRelease(row: any): MovieRelease {
  return {
    ...row,
    is_dubbed: Boolean(row.is_dubbed),
    manually_ignored: Boolean(row.manually_ignored),
  };
}

export const movieReleasesModel = {
  getAll: (status?: ReleaseStatus): MovieRelease[] => {
    let rows: any[];
    // Only return releases that have a corresponding RSS item (to avoid orphaned releases)
    if (status) {
      rows = db.prepare(`
        SELECT r.* FROM movie_releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        WHERE r.status = ?
        ORDER BY r.published_at DESC
      `).all(status) as any[];
    } else {
      rows = db.prepare(`
        SELECT r.* FROM movie_releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        ORDER BY r.published_at DESC
      `).all() as any[];
    }
    return rows.map(convertRelease);
  },

  getByStatus: (status: ReleaseStatus): MovieRelease[] => {
    const rows = db
      .prepare('SELECT * FROM movie_releases WHERE status = ? ORDER BY published_at DESC')
      .all(status) as any[];
    return rows.map(convertRelease);
  },

  getById: (id: number): MovieRelease | undefined => {
    const row = db.prepare('SELECT * FROM movie_releases WHERE id = ?').get(id) as any;
    return row ? convertRelease(row) : undefined;
  },

  getByGuid: (guid: string): MovieRelease | undefined => {
    const row = db.prepare('SELECT * FROM movie_releases WHERE guid = ?').get(guid) as any;
    return row ? convertRelease(row) : undefined;
  },

  upsert: (release: Omit<MovieRelease, 'id'>): MovieRelease => {
    const existing = movieReleasesModel.getByGuid(release.guid);
    
    if (existing) {
      const manuallyIgnored =
        typeof release.manually_ignored === 'boolean'
          ? release.manually_ignored
          : Boolean(existing.manually_ignored);
      // Update existing release, but preserve status if it's ADDED, UPGRADED, or manually ignored
      const status =
        existing.status === 'ADDED' ||
        existing.status === 'UPGRADED' ||
        manuallyIgnored
          ? existing.status
          : release.status;

              db.prepare(`
                UPDATE movie_releases SET
                  title = ?,
                  normalized_title = ?,
                  year = ?,
                  source_site = ?,
                  feed_id = ?,
                  link = ?,
                  resolution = ?,
                  source_tag = ?,
                  codec = ?,
                  audio = ?,
                  rss_size_mb = ?,
                  existing_size_mb = ?,
                  published_at = ?,
                  tmdb_id = ?,
                  tmdb_title = ?,
                  tmdb_original_language = ?,
                  tmdb_poster_url = ?,
                  imdb_id = ?,
                  is_dubbed = ?,
                  audio_languages = ?,
                  radarr_movie_id = ?,
                  radarr_movie_title = ?,
                  radarr_existing_quality_score = ?,
                  new_quality_score = ?,
                  status = ?,
                  existing_file_path = ?,
                  existing_file_attributes = ?,
                radarr_history = ?,
                  manually_ignored = ?,
                  last_checked_at = datetime('now')
                WHERE guid = ?
              `).run(
                release.title,
                release.normalized_title,
                release.year || null,
                release.source_site,
                release.feed_id,
                release.link,
                release.resolution,
                release.source_tag,
                release.codec,
                release.audio,
                release.rss_size_mb || null,
                release.existing_size_mb || null,
                release.published_at,
                release.tmdb_id || null,
                release.tmdb_title || null,
                release.tmdb_original_language || null,
                release.tmdb_poster_url || null,
                release.imdb_id || null,
                release.is_dubbed ? 1 : 0,
                release.audio_languages || null,
                release.radarr_movie_id || null,
                release.radarr_movie_title || null,
                release.radarr_existing_quality_score || null,
                release.new_quality_score || null,
                status,
                (release as any).existing_file_path || null,
                (release as any).existing_file_attributes || null,
                (release as any).radarr_history || null,
                manuallyIgnored ? 1 : 0,
                release.guid
              );
      return movieReleasesModel.getByGuid(release.guid)!;
    } else {
      // Insert new release
      const result = db.prepare(`
        INSERT INTO movie_releases (
          guid, title, normalized_title, year, source_site, feed_id, link,
          resolution, source_tag, codec, audio, rss_size_mb, existing_size_mb,
          published_at, tmdb_id, tmdb_title, tmdb_original_language, tmdb_poster_url, imdb_id, is_dubbed,
          audio_languages, radarr_movie_id, radarr_movie_title,
          radarr_existing_quality_score, new_quality_score, status,
          existing_file_path, existing_file_attributes, radarr_history, manually_ignored
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        release.guid,
        release.title,
        release.normalized_title,
        release.year || null,
        release.source_site,
        release.feed_id,
        release.link,
        release.resolution,
        release.source_tag,
        release.codec,
        release.audio,
        release.rss_size_mb || null,
        release.existing_size_mb || null,
        release.published_at,
        release.tmdb_id || null,
        release.tmdb_title || null,
        release.tmdb_original_language || null,
        release.tmdb_poster_url || null,
        release.imdb_id || null,
        release.is_dubbed ? 1 : 0,
        release.audio_languages || null,
        release.radarr_movie_id || null,
        release.radarr_movie_title || null,
        release.radarr_existing_quality_score || null,
        release.new_quality_score || null,
        release.status,
        (release as any).existing_file_path || null,
        (release as any).existing_file_attributes || null,
        (release as any).radarr_history || null,
        release.manually_ignored ? 1 : 0
      );
      return movieReleasesModel.getById(result.lastInsertRowid as number)!;
    }
  },

  updateStatus: (id: number, status: ReleaseStatus, options?: { manuallyIgnored?: boolean }): boolean => {
    const manuallyIgnored =
      typeof options?.manuallyIgnored === 'boolean'
        ? options.manuallyIgnored
        : status === 'IGNORED';
    const result = db
      .prepare(
        'UPDATE movie_releases SET status = ?, manually_ignored = ?, last_checked_at = datetime(\'now\') WHERE id = ?'
      )
      .run(status, manuallyIgnored ? 1 : 0, id);
    return result.changes > 0;
  },
};

// Legacy alias for backward compatibility during migration
export const releasesModel = movieReleasesModel;

