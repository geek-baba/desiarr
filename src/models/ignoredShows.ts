import db from '../db';

export type ShowIdentifier = {
  tvdbId?: number | null;
  tmdbId?: number | null;
  showName?: string | null;
};

export function buildShowKey({ tvdbId, tmdbId, showName }: ShowIdentifier): string {
  if (tvdbId) return `tvdb:${tvdbId}`;
  if (tmdbId) return `tmdb:${tmdbId}`;
  if (showName && showName.trim()) return `name:${showName.trim().toLowerCase()}`;
  return '';
}

export const ignoredShowsModel = {
  add(identifier: ShowIdentifier) {
    const key = buildShowKey(identifier);
    if (!key) {
      throw new Error('Cannot build show key for ignore list');
    }
    db.prepare(
      `INSERT OR REPLACE INTO ignored_shows (show_key, show_name, tvdb_id, tmdb_id)
       VALUES (?, ?, ?, ?)`
    ).run(
      key,
      identifier.showName || null,
      identifier.tvdbId || null,
      identifier.tmdbId || null
    );
  },

  remove(identifier: ShowIdentifier) {
    const key = buildShowKey(identifier);
    if (!key) return;
    db.prepare('DELETE FROM ignored_shows WHERE show_key = ?').run(key);
  },

  getAllKeys(): Set<string> {
    const rows = db.prepare('SELECT show_key FROM ignored_shows').all() as { show_key: string }[];
    return new Set(rows.map((row) => row.show_key));
  },

  isIgnored(identifier: ShowIdentifier): boolean {
    const key = buildShowKey(identifier);
    if (!key) return false;
    const row = db.prepare('SELECT 1 FROM ignored_shows WHERE show_key = ?').get(key);
    return Boolean(row);
  },
};

