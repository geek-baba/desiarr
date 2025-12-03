import db from '../db';
import { TvRelease, TvReleaseStatus } from '../types/Release';

function convertTvRelease(row: any): TvRelease {
  return {
    ...row,
    season_number: row.season_number ? parseInt(row.season_number, 10) : undefined,
    manually_ignored: Boolean(row.manually_ignored),
  };
}

export const tvReleasesModel = {
  getAll: (status?: TvReleaseStatus): TvRelease[] => {
    let rows: any[];
    if (status) {
      rows = db.prepare(`
        SELECT r.* FROM tv_releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        WHERE r.status = ?
        ORDER BY r.published_at DESC
      `).all(status) as any[];
    } else {
      rows = db.prepare(`
        SELECT r.* FROM tv_releases r
        INNER JOIN rss_feed_items rss ON r.guid = rss.guid
        ORDER BY r.published_at DESC
      `).all() as any[];
    }
    return rows.map(convertTvRelease);
  },

  getByStatus: (status: TvReleaseStatus): TvRelease[] => {
    const rows = db
      .prepare('SELECT * FROM tv_releases WHERE status = ? ORDER BY published_at DESC')
      .all(status) as any[];
    return rows.map(convertTvRelease);
  },

  getById: (id: number): TvRelease | undefined => {
    const row = db.prepare('SELECT * FROM tv_releases WHERE id = ?').get(id) as any;
    return row ? convertTvRelease(row) : undefined;
  },

  getByGuid: (guid: string): TvRelease | undefined => {
    const row = db.prepare('SELECT * FROM tv_releases WHERE guid = ?').get(guid) as any;
    return row ? convertTvRelease(row) : undefined;
  },

  upsert: (release: Omit<TvRelease, 'id'>): TvRelease => {
    const existing = tvReleasesModel.getByGuid(release.guid);
    
    // Check if this show is in the ignored list (for both new and existing releases)
    const { buildShowKey, ignoredShowsModel } = require('./ignoredShows');
    const showKey = buildShowKey({
      tvdbId: release.tvdb_id || null,
      tmdbId: release.tmdb_id || null,
      showName: release.show_name || null,
    });
    const isIgnoredInList = showKey ? ignoredShowsModel.isIgnored({
      tvdbId: release.tvdb_id || null,
      tmdbId: release.tmdb_id || null,
      showName: release.show_name || null,
    }) : false;
    
    if (existing) {
      const manuallyIgnored =
        typeof release.manually_ignored === 'boolean'
          ? release.manually_ignored
          : Boolean(existing.manually_ignored) || isIgnoredInList;
      // Update existing release, but preserve status if it's ADDED or manually ignored
      const status =
        existing.status === 'ADDED' || manuallyIgnored
          ? existing.status
          : release.status;

      // Preserve existing IDs if new release doesn't have them (to avoid overwriting manually set IDs)
      const tvdbId = release.tvdb_id ?? existing.tvdb_id ?? null;
      const tvdbSlug = release.tvdb_slug ?? existing.tvdb_slug ?? null;
      const tmdbId = release.tmdb_id ?? existing.tmdb_id ?? null;
      const imdbId = release.imdb_id ?? existing.imdb_id ?? null;

      db.prepare(`
        UPDATE tv_releases SET
          title = ?,
          normalized_title = ?,
          show_name = ?,
          season_number = ?,
          source_site = ?,
          feed_id = ?,
          link = ?,
          published_at = ?,
          tvdb_id = ?,
          tvdb_slug = ?,
          tmdb_id = ?,
          imdb_id = ?,
          tvdb_poster_url = ?,
          tmdb_poster_url = ?,
          sonarr_series_id = ?,
          sonarr_series_title = ?,
          status = ?,
          manually_ignored = ?,
          last_checked_at = datetime('now')
        WHERE guid = ?
      `).run(
        release.title ?? null,
        release.normalized_title ?? null,
        release.show_name ?? null,
        release.season_number ?? null, // Optional field - convert undefined to null
        release.source_site ?? null,
        release.feed_id ?? null,
        release.link ?? null,
        release.published_at ?? null,
        tvdbId ?? null, // Already converted but add defensive check
        tvdbSlug ?? null, // Already converted but add defensive check
        tmdbId ?? null, // Already converted but add defensive check
        imdbId ?? null, // Already converted but add defensive check
        release.tvdb_poster_url ?? null, // Optional field - convert undefined to null
        release.tmdb_poster_url ?? null, // Optional field - convert undefined to null
        release.sonarr_series_id ?? null, // Optional field - convert undefined to null
        release.sonarr_series_title ?? null, // Optional field - convert undefined to null
        status ?? null,
        manuallyIgnored ? 1 : 0,
        release.guid ?? null
      );
      return tvReleasesModel.getByGuid(release.guid)!;
    } else {
      // Insert new release
      // Check if show is ignored and override status/manually_ignored if needed
      const finalManuallyIgnored = isIgnoredInList || (release.manually_ignored ? 1 : 0);
      const finalStatus = isIgnoredInList ? 'IGNORED' : release.status;
      
      const result = db.prepare(`
        INSERT INTO tv_releases (
          guid, title, normalized_title, show_name, season_number, source_site, feed_id, link,
          published_at, tvdb_id, tvdb_slug, tmdb_id, imdb_id, tvdb_poster_url, tmdb_poster_url,
          sonarr_series_id, sonarr_series_title, status, manually_ignored
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        release.guid ?? null,
        release.title ?? null,
        release.normalized_title ?? null,
        release.show_name ?? null,
        release.season_number ?? null, // Optional field - convert undefined to null
        release.source_site ?? null,
        release.feed_id ?? null,
        release.link ?? null,
        release.published_at ?? null,
        release.tvdb_id ?? null, // Optional field - convert undefined to null
        release.tvdb_slug ?? null, // Optional field - convert undefined to null
        release.tmdb_id ?? null, // Optional field - convert undefined to null
        release.imdb_id ?? null, // Optional field - convert undefined to null
        release.tvdb_poster_url ?? null, // Optional field - convert undefined to null
        release.tmdb_poster_url ?? null, // Optional field - convert undefined to null
        release.sonarr_series_id ?? null, // Optional field - convert undefined to null
        release.sonarr_series_title ?? null, // Optional field - convert undefined to null
        finalStatus ?? null,
        finalManuallyIgnored ?? 0
      );
      return tvReleasesModel.getById(result.lastInsertRowid as number)!;
    }
  },

  updateStatus: (id: number, status: TvReleaseStatus, options?: { manuallyIgnored?: boolean }): boolean => {
    const manuallyIgnored =
      typeof options?.manuallyIgnored === 'boolean'
        ? options.manuallyIgnored
        : status === 'IGNORED';
    const result = db
      .prepare(
        'UPDATE tv_releases SET status = ?, manually_ignored = ?, last_checked_at = datetime(\'now\') WHERE id = ?'
      )
      .run(status, manuallyIgnored ? 1 : 0, id);
    return result.changes > 0;
  },

  markShowIgnoreByIdentifiers: (identifier: { tvdbId?: number | null; tmdbId?: number | null; showName?: string | null }, manuallyIgnored: boolean) => {
    const conditions: string[] = [];
    const params: any[] = [];
    if (identifier.tvdbId) {
      conditions.push('tvdb_id = ?');
      params.push(identifier.tvdbId);
    }
    if (identifier.tmdbId) {
      conditions.push('tmdb_id = ?');
      params.push(identifier.tmdbId);
    }
    if (identifier.showName) {
      conditions.push('LOWER(show_name) = LOWER(?)');
      params.push(identifier.showName);
    }
    if (conditions.length === 0) {
      return;
    }
    const whereClause = conditions.join(' OR ');
    db.prepare(
      `UPDATE tv_releases
       SET manually_ignored = ?, status = CASE WHEN ? = 1 THEN 'IGNORED' ELSE status END, last_checked_at = datetime('now')
       WHERE ${whereClause}`
    ).run(manuallyIgnored ? 1 : 0, manuallyIgnored ? 1 : 0, ...params);
  },
};

