import Database from 'better-sqlite3';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db: Database.Database = new Database(config.db.path);
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS rss_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    year INTEGER,
    source_site TEXT NOT NULL,
    feed_id INTEGER NOT NULL,
    link TEXT NOT NULL,
    resolution TEXT NOT NULL,
    source_tag TEXT NOT NULL,
    codec TEXT NOT NULL,
    audio TEXT NOT NULL,
    rss_size_mb REAL,
    existing_size_mb REAL,
    published_at TEXT NOT NULL,
    tmdb_id INTEGER,
    tmdb_title TEXT,
    tmdb_original_language TEXT,
    tmdb_poster_url TEXT,
    imdb_id TEXT,
    is_dubbed INTEGER,
    audio_languages TEXT,
    radarr_movie_id INTEGER,
    radarr_movie_title TEXT,
    radarr_existing_quality_score REAL,
    new_quality_score REAL,
    status TEXT NOT NULL DEFAULT 'NEW',
    last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    existing_file_path TEXT,
    existing_file_attributes TEXT,
    radarr_history TEXT,
    FOREIGN KEY (feed_id) REFERENCES rss_feeds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
  CREATE INDEX IF NOT EXISTS idx_releases_guid ON releases(guid);
  CREATE INDEX IF NOT EXISTS idx_releases_tmdb_id ON releases(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_releases_radarr_movie_id ON releases(radarr_movie_id);

  // Add poster_url column if it doesn't exist (migration)
  // Check if column exists by trying to query it
  try {
    db.prepare('SELECT tmdb_poster_url FROM releases LIMIT 1').get();
  } catch (error: any) {
    // Column doesn't exist, add it
    if (error && error.message && error.message.includes('no such column')) {
      try {
        db.exec('ALTER TABLE releases ADD COLUMN tmdb_poster_url TEXT');
        console.log('Added tmdb_poster_url column to releases table');
      } catch (alterError) {
        console.error('Error adding tmdb_poster_url column:', alterError);
      }
    }
  }

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS radarr_movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    radarr_id INTEGER UNIQUE NOT NULL,
    tmdb_id INTEGER,
    imdb_id TEXT,
    title TEXT NOT NULL,
    year INTEGER,
    path TEXT,
    has_file INTEGER NOT NULL DEFAULT 0,
    movie_file TEXT,
    original_language TEXT,
    images TEXT,
    date_added TEXT,
    synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rss_feed_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    feed_id INTEGER NOT NULL,
    feed_name TEXT NOT NULL,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    clean_title TEXT,
    year INTEGER,
    source_site TEXT NOT NULL,
    link TEXT NOT NULL,
    resolution TEXT NOT NULL,
    source_tag TEXT NOT NULL,
    codec TEXT NOT NULL,
    audio TEXT NOT NULL,
    rss_size_mb REAL,
    published_at TEXT NOT NULL,
    tmdb_id INTEGER,
    imdb_id TEXT,
    tmdb_id_manual INTEGER DEFAULT 0,
    imdb_id_manual INTEGER DEFAULT 0,
    audio_languages TEXT,
    raw_data TEXT,
    synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (feed_id) REFERENCES rss_feeds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_radarr_movies_tmdb_id ON radarr_movies(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_radarr_movies_radarr_id ON radarr_movies(radarr_id);
  CREATE INDEX IF NOT EXISTS idx_rss_feed_items_feed_id ON rss_feed_items(feed_id);
  CREATE INDEX IF NOT EXISTS idx_rss_feed_items_guid ON rss_feed_items(guid);
  CREATE INDEX IF NOT EXISTS idx_rss_feed_items_tmdb_id ON rss_feed_items(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_rss_feed_items_published_at ON rss_feed_items(published_at);

  CREATE TABLE IF NOT EXISTS structured_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL CHECK(level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    file_path TEXT,
    release_title TEXT,
    job_id TEXT,
    error_stack TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON structured_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON structured_logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_source ON structured_logs(source);
  CREATE INDEX IF NOT EXISTS idx_logs_job_id ON structured_logs(job_id);
  CREATE INDEX IF NOT EXISTS idx_logs_message ON structured_logs(message);
`);

// Migrate existing databases - add new columns if they don't exist
try {
  // Check rss_feed_items table for manual ID tracking columns
  const rssColumns = db.prepare("PRAGMA table_info(rss_feed_items)").all() as any[];
  const rssColumnNames = rssColumns.map((c: any) => c.name);
  
  if (!rssColumnNames.includes('tmdb_id_manual')) {
    db.exec('ALTER TABLE rss_feed_items ADD COLUMN tmdb_id_manual INTEGER DEFAULT 0');
    console.log('Added column: rss_feed_items.tmdb_id_manual');
  }
  
  if (!rssColumnNames.includes('imdb_id_manual')) {
    db.exec('ALTER TABLE rss_feed_items ADD COLUMN imdb_id_manual INTEGER DEFAULT 0');
    console.log('Added column: rss_feed_items.imdb_id_manual');
  }
  
  const columns = db.prepare("PRAGMA table_info(releases)").all() as any[];
  const columnNames = columns.map((c: any) => c.name);
  
  if (!columnNames.includes('existing_file_path')) {
    db.exec('ALTER TABLE releases ADD COLUMN existing_file_path TEXT');
    console.log('Added column: existing_file_path');
  }
  if (!columnNames.includes('existing_file_attributes')) {
    db.exec('ALTER TABLE releases ADD COLUMN existing_file_attributes TEXT');
    console.log('Added column: existing_file_attributes');
  }
  if (!columnNames.includes('radarr_history')) {
    db.exec('ALTER TABLE releases ADD COLUMN radarr_history TEXT');
    console.log('Added column: radarr_history');
  }
  if (!columnNames.includes('imdb_id')) {
    db.exec('ALTER TABLE releases ADD COLUMN imdb_id TEXT');
    console.log('Added column: imdb_id');
  }
  
  // Check radarr_movies table for date_added column
  const radarrColumns = db.prepare("PRAGMA table_info(radarr_movies)").all() as any[];
  const radarrColumnNames = radarrColumns.map((c: any) => c.name);
  
  if (!radarrColumnNames.includes('date_added')) {
    db.exec('ALTER TABLE radarr_movies ADD COLUMN date_added TEXT');
    console.log('Added column: radarr_movies.date_added');
  }
  
  // Check if structured_logs table exists
  const logsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='structured_logs'").get();
  if (!logsTable) {
    db.exec(`
      CREATE TABLE structured_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        level TEXT NOT NULL CHECK(level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        file_path TEXT,
        release_title TEXT,
        job_id TEXT,
        error_stack TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_logs_timestamp ON structured_logs(timestamp DESC);
      CREATE INDEX idx_logs_level ON structured_logs(level);
      CREATE INDEX idx_logs_source ON structured_logs(source);
      CREATE INDEX idx_logs_job_id ON structured_logs(job_id);
      CREATE INDEX idx_logs_message ON structured_logs(message);
    `);
    console.log('Created table: structured_logs');
  }
} catch (error) {
  console.error('Migration error:', error);
}

// Initialize default quality settings if not exists
const defaultSettings = {
  resolutions: [
    { resolution: '2160p', allowed: false, preferredCodecs: ['x265', 'HEVC'], discouragedCodecs: ['x264'] },
    { resolution: '1080p', allowed: true, preferredCodecs: ['x264'], discouragedCodecs: ['x265', 'HEVC'] },
    { resolution: '720p', allowed: true, preferredCodecs: ['x264'], discouragedCodecs: [] },
    { resolution: '480p', allowed: true, preferredCodecs: [], discouragedCodecs: [] },
    { resolution: 'UNKNOWN', allowed: true, preferredCodecs: [], discouragedCodecs: [] },
  ],
  resolutionWeights: {
    '2160p': 100,
    '1080p': 80,
    '720p': 50,
    '480p': 20,
    'UNKNOWN': 10,
  },
  sourceTagWeights: {
    'AMZN': 90,
    'NF': 90,
    'JC': 85,
    'ZEE5': 80,
    'DSNP': 85,
    'HS': 75,
    'SS': 85,
    'OTHER': 50,
  },
  codecWeights: {
    'x265': 70,
    'HEVC': 70,
    'x264': 80,
    'AVC': 80,
    'UNKNOWN': 30,
  },
  audioWeights: {
    'Atmos': 100,
    'TrueHD': 90,
    'DDP5.1': 85,
    'DD5.1': 70,
    '2.0': 40,
  },
  preferredAudioLanguages: ['hi', 'en'],
  dubbedPenalty: -20,
  preferredLanguageBonus: 15,
  sizeBonusEnabled: true,
  minSizeIncreasePercentForUpgrade: 10,
  upgradeThreshold: 20,
  pollIntervalMinutes: 60,
  radarrSyncIntervalHours: 6,
  rssSyncIntervalHours: 1,
};

const existingSettings = db.prepare("SELECT value FROM app_settings WHERE key = 'qualitySettings'").get();
if (!existingSettings) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('qualitySettings', ?)").run(
    JSON.stringify(defaultSettings)
  );
}

export default db;

