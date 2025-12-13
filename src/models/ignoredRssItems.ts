import db from '../db';

export const ignoredRssItemsModel = {
  add(guid: string, title?: string | null, reason?: string | null) {
    db.prepare(
      `INSERT OR REPLACE INTO ignored_rss_items (guid, title, reason, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(guid, title || null, reason || null);
  },

  remove(guid: string) {
    db.prepare('DELETE FROM ignored_rss_items WHERE guid = ?').run(guid);
  },

  getAllGuids(): Set<string> {
    const rows = db.prepare('SELECT guid FROM ignored_rss_items').all() as { guid: string }[];
    return new Set(rows.map((row) => row.guid));
  },

  isIgnored(guid: string): boolean {
    const row = db.prepare('SELECT 1 FROM ignored_rss_items WHERE guid = ?').get(guid);
    return Boolean(row);
  },

  getAll(): Array<{ id: number; guid: string; title: string | null; reason: string | null; created_at: string }> {
    return db.prepare('SELECT * FROM ignored_rss_items ORDER BY created_at DESC').all() as any[];
  },
};

