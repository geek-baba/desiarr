import db from '../db';

export interface RSSFeed {
  id?: number;
  name: string;
  url: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

function convertFeed(row: any): RSSFeed {
  return {
    ...row,
    enabled: Boolean(row.enabled),
  };
}

export const feedsModel = {
  getAll: (): RSSFeed[] => {
    const rows = db.prepare('SELECT * FROM rss_feeds ORDER BY name').all() as any[];
    return rows.map(convertFeed);
  },

  getEnabled: (): RSSFeed[] => {
    const rows = db.prepare('SELECT * FROM rss_feeds WHERE enabled = 1 ORDER BY name').all() as any[];
    return rows.map(convertFeed);
  },

  getById: (id: number): RSSFeed | undefined => {
    const row = db.prepare('SELECT * FROM rss_feeds WHERE id = ?').get(id) as any;
    return row ? convertFeed(row) : undefined;
  },

  create: (feed: Omit<RSSFeed, 'id' | 'created_at' | 'updated_at'>): RSSFeed => {
    const result = db
      .prepare('INSERT INTO rss_feeds (name, url, enabled) VALUES (?, ?, ?)')
      .run(feed.name, feed.url, feed.enabled ? 1 : 0);
    return feedsModel.getById(result.lastInsertRowid as number)!;
  },

  update: (id: number, feed: Partial<Omit<RSSFeed, 'id' | 'created_at'>>): RSSFeed | undefined => {
    const updates: string[] = [];
    const values: any[] = [];

    if (feed.name !== undefined) {
      updates.push('name = ?');
      values.push(feed.name);
    }
    if (feed.url !== undefined) {
      updates.push('url = ?');
      values.push(feed.url);
    }
    if (feed.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(feed.enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return feedsModel.getById(id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE rss_feeds SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return feedsModel.getById(id);
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM rss_feeds WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

