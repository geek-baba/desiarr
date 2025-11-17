import Database from 'better-sqlite3';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);
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
    is_dubbed INTEGER,
    audio_languages TEXT,
    radarr_movie_id INTEGER,
    radarr_movie_title TEXT,
    radarr_existing_quality_score REAL,
    new_quality_score REAL,
    status TEXT NOT NULL DEFAULT 'NEW',
    last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (feed_id) REFERENCES rss_feeds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
  CREATE INDEX IF NOT EXISTS idx_releases_guid ON releases(guid);
  CREATE INDEX IF NOT EXISTS idx_releases_tmdb_id ON releases(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_releases_radarr_movie_id ON releases(radarr_movie_id);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

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
};

const existingSettings = db.prepare("SELECT value FROM app_settings WHERE key = 'qualitySettings'").get();
if (!existingSettings) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('qualitySettings', ?)").run(
    JSON.stringify(defaultSettings)
  );
}

export default db;

