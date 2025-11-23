import db from '../db';
import { Release, ReleaseStatus } from '../types/Release';

function convertRelease(row: any): Release {
  return {
    ...row,
    is_dubbed: Boolean(row.is_dubbed),
  };
}

export const releasesModel = {
  getAll: (status?: ReleaseStatus): Release[] => {
    let rows: any[];
    // Only return releases that have a corresponding RSS item (to avoid orphaned releases)
    if (status) {
      rows = db.prepare(`
        SELECT r.* FROM releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        WHERE r.status = ?
        ORDER BY r.published_at DESC
      `).all(status) as any[];
    } else {
      rows = db.prepare(`
        SELECT r.* FROM releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        ORDER BY r.published_at DESC
      `).all() as any[];
    }
    return rows.map(convertRelease);
  },

  getByStatus: (status: ReleaseStatus): Release[] => {
    const rows = db
      .prepare('SELECT * FROM releases WHERE status = ? ORDER BY published_at DESC')
      .all(status) as any[];
    return rows.map(convertRelease);
  },

  getById: (id: number): Release | undefined => {
    const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as any;
    return row ? convertRelease(row) : undefined;
  },

  getByGuid: (guid: string): Release | undefined => {
    const row = db.prepare('SELECT * FROM releases WHERE guid = ?').get(guid) as any;
    return row ? convertRelease(row) : undefined;
  },

  upsert: (release: Omit<Release, 'id'>): Release => {
    const existing = releasesModel.getByGuid(release.guid);
    
    if (existing) {
      // Update existing release, but preserve status if it's ADDED or UPGRADED
      const status = existing.status === 'ADDED' || existing.status === 'UPGRADED' 
        ? existing.status 
        : release.status;

              db.prepare(`
                UPDATE releases SET
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
                release.guid
              );
      return releasesModel.getByGuid(release.guid)!;
    } else {
      // Insert new release
      const result = db.prepare(`
        INSERT INTO releases (
          guid, title, normalized_title, year, source_site, feed_id, link,
          resolution, source_tag, codec, audio, rss_size_mb, existing_size_mb,
          published_at, tmdb_id, tmdb_title, tmdb_original_language, tmdb_poster_url, imdb_id, is_dubbed,
          audio_languages, radarr_movie_id, radarr_movie_title,
          radarr_existing_quality_score, new_quality_score, status,
          existing_file_path, existing_file_attributes, radarr_history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        (release as any).radarr_history || null
      );
      return releasesModel.getById(result.lastInsertRowid as number)!;
    }
  },

  updateStatus: (id: number, status: ReleaseStatus): boolean => {
    const result = db.prepare('UPDATE releases SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?').run(status, id);
    return result.changes > 0;
  },
};

