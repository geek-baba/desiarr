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

  CREATE TABLE IF NOT EXISTS movie_releases (
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

  CREATE INDEX IF NOT EXISTS idx_movie_releases_status ON movie_releases(status);
  CREATE INDEX IF NOT EXISTS idx_movie_releases_guid ON movie_releases(guid);
  CREATE INDEX IF NOT EXISTS idx_movie_releases_tmdb_id ON movie_releases(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_movie_releases_radarr_movie_id ON movie_releases(radarr_movie_id);

  CREATE TABLE IF NOT EXISTS tv_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    show_name TEXT NOT NULL,
    season_number INTEGER,
    source_site TEXT NOT NULL,
    feed_id INTEGER NOT NULL,
    link TEXT NOT NULL,
    published_at TEXT NOT NULL,
    tvdb_id INTEGER,
    tmdb_id INTEGER,
    imdb_id TEXT,
    tvdb_poster_url TEXT,
    tmdb_poster_url TEXT,
    sonarr_series_id INTEGER,
    sonarr_series_title TEXT,
    status TEXT NOT NULL DEFAULT 'NEW_SHOW',
    last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (feed_id) REFERENCES rss_feeds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tv_releases_status ON tv_releases(status);
  CREATE INDEX IF NOT EXISTS idx_tv_releases_guid ON tv_releases(guid);
  CREATE INDEX IF NOT EXISTS idx_tv_releases_tvdb_id ON tv_releases(tvdb_id);
  CREATE INDEX IF NOT EXISTS idx_tv_releases_tmdb_id ON tv_releases(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_tv_releases_sonarr_series_id ON tv_releases(sonarr_series_id);

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

  CREATE TABLE IF NOT EXISTS sonarr_shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sonarr_id INTEGER UNIQUE NOT NULL,
    tvdb_id INTEGER,
    tmdb_id INTEGER,
    imdb_id TEXT,
    title TEXT NOT NULL,
    year INTEGER,
    path TEXT,
    monitored INTEGER NOT NULL DEFAULT 1,
    seasons TEXT,
    images TEXT,
    date_added TEXT,
    synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sonarr_shows_tvdb_id ON sonarr_shows(tvdb_id);
  CREATE INDEX IF NOT EXISTS idx_sonarr_shows_tmdb_id ON sonarr_shows(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_sonarr_shows_sonarr_id ON sonarr_shows(sonarr_id);

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

  CREATE TABLE IF NOT EXISTS tmdb_movie_cache (
    tmdb_id INTEGER PRIMARY KEY,
    title TEXT,
    original_title TEXT,
    original_language TEXT,
    release_date TEXT,
    production_countries TEXT,
    origin_country TEXT,
    primary_country TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    overview TEXT,
    tagline TEXT,
    imdb_id TEXT,
    genres TEXT,
    production_companies TEXT,
    spoken_languages TEXT,
    belongs_to_collection TEXT,
    budget INTEGER,
    revenue INTEGER,
    runtime INTEGER,
    popularity REAL,
    vote_average REAL,
    vote_count INTEGER,
    status TEXT,
    adult INTEGER DEFAULT 0,
    video INTEGER DEFAULT 0,
    homepage TEXT,
    synced_at TEXT NOT NULL,
    last_updated_at TEXT,
    is_deleted INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tmdb_cache_tmdb_id ON tmdb_movie_cache(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_tmdb_cache_synced_at ON tmdb_movie_cache(synced_at);

  CREATE TABLE IF NOT EXISTS radarr_movie_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    radarr_id INTEGER NOT NULL,
    tmdb_id INTEGER,
    title TEXT,
    history_data TEXT NOT NULL,
    preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
    restored_to_radarr_id INTEGER,
    restored_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_history_radarr_id ON radarr_movie_history(radarr_id);
  CREATE INDEX IF NOT EXISTS idx_history_tmdb_id ON radarr_movie_history(tmdb_id);
`);

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
  
  // Migrate tmdb_movie_cache table - add new columns if they don't exist
  const tmdbColumns = db.prepare("PRAGMA table_info(tmdb_movie_cache)").all() as any[];
  const tmdbColumnNames = tmdbColumns.map((c: any) => c.name);
  
  const newTmdbColumns = [
    { name: 'tagline', type: 'TEXT' },
    { name: 'genres', type: 'TEXT' },
    { name: 'production_companies', type: 'TEXT' },
    { name: 'spoken_languages', type: 'TEXT' },
    { name: 'belongs_to_collection', type: 'TEXT' },
    { name: 'budget', type: 'INTEGER' },
    { name: 'revenue', type: 'INTEGER' },
    { name: 'runtime', type: 'INTEGER' },
    { name: 'popularity', type: 'REAL' },
    { name: 'vote_average', type: 'REAL' },
    { name: 'vote_count', type: 'INTEGER' },
    { name: 'status', type: 'TEXT' },
    { name: 'adult', type: 'INTEGER DEFAULT 0' },
    { name: 'video', type: 'INTEGER DEFAULT 0' },
    { name: 'homepage', type: 'TEXT' },
    { name: 'origin_country', type: 'TEXT' },
  ];
  
  for (const col of newTmdbColumns) {
    if (!tmdbColumnNames.includes(col.name)) {
      db.exec(`ALTER TABLE tmdb_movie_cache ADD COLUMN ${col.name} ${col.type}`);
      console.log(`Added column: tmdb_movie_cache.${col.name}`);
    }
  }

  if (!rssColumnNames.includes('tvdb_id')) {
    db.exec('ALTER TABLE rss_feed_items ADD COLUMN tvdb_id INTEGER');
    console.log('Added column: rss_feed_items.tvdb_id');
  }
  
  if (!rssColumnNames.includes('tvdb_id_manual')) {
    db.exec('ALTER TABLE rss_feed_items ADD COLUMN tvdb_id_manual INTEGER DEFAULT 0');
    console.log('Added column: rss_feed_items.tvdb_id_manual');
  }
  
  if (!rssColumnNames.includes('feed_type_override')) {
    db.exec("ALTER TABLE rss_feed_items ADD COLUMN feed_type_override TEXT");
    console.log('Added column: rss_feed_items.feed_type_override');
  }
  
  // Check radarr_movies table for date_added column
  const radarrColumns = db.prepare("PRAGMA table_info(radarr_movies)").all() as any[];
  const radarrColumnNames = radarrColumns.map((c: any) => c.name);
  
  if (!radarrColumnNames.includes('date_added')) {
    db.exec('ALTER TABLE radarr_movies ADD COLUMN date_added TEXT');
    console.log('Added column: radarr_movies.date_added');
  }
  
  // Check rss_feeds table for feed_type column
  const feedColumns = db.prepare("PRAGMA table_info(rss_feeds)").all() as any[];
  const feedColumnNames = feedColumns.map((c: any) => c.name);
  
  if (!feedColumnNames.includes('feed_type')) {
    db.exec("ALTER TABLE rss_feeds ADD COLUMN feed_type TEXT NOT NULL DEFAULT 'movie'");
    console.log('Added column: rss_feeds.feed_type');
    // Migrate existing feeds to 'movie' type (already default, but explicit update for clarity)
    db.exec("UPDATE rss_feeds SET feed_type = 'movie' WHERE feed_type IS NULL OR feed_type = ''");
    console.log('Migrated existing feeds to movie type');
  }
  
  // Migrate releases table to movie_releases if it exists
  const releasesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='releases'").get();
  const movieReleasesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='movie_releases'").get();
  
  if (releasesTable && !movieReleasesTable) {
    console.log('Migrating releases table to movie_releases...');
    // Rename table
    db.exec('ALTER TABLE releases RENAME TO movie_releases');
    console.log('Renamed releases table to movie_releases');
    
    // Rename indexes
    try {
      db.exec('DROP INDEX IF EXISTS idx_releases_status');
      db.exec('DROP INDEX IF EXISTS idx_releases_guid');
      db.exec('DROP INDEX IF EXISTS idx_releases_tmdb_id');
      db.exec('DROP INDEX IF EXISTS idx_releases_radarr_movie_id');
    } catch (e) {
      // Indexes might not exist, continue
    }
    
    // Recreate indexes with new names
    db.exec('CREATE INDEX IF NOT EXISTS idx_movie_releases_status ON movie_releases(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_movie_releases_guid ON movie_releases(guid)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_movie_releases_tmdb_id ON movie_releases(tmdb_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_movie_releases_radarr_movie_id ON movie_releases(radarr_movie_id)');
    console.log('Recreated indexes for movie_releases');
  }
  
  // Update migration code that references 'releases' to use 'movie_releases'
  const movieReleaseColumns = db.prepare("PRAGMA table_info(movie_releases)").all() as any[];
  const movieReleaseColumnNames = movieReleaseColumns.map((c: any) => c.name);
  
  if (movieReleaseColumnNames.length > 0) {
    if (!movieReleaseColumnNames.includes('existing_file_path')) {
      db.exec('ALTER TABLE movie_releases ADD COLUMN existing_file_path TEXT');
      console.log('Added column: movie_releases.existing_file_path');
    }
    if (!movieReleaseColumnNames.includes('existing_file_attributes')) {
      db.exec('ALTER TABLE movie_releases ADD COLUMN existing_file_attributes TEXT');
      console.log('Added column: movie_releases.existing_file_attributes');
    }
    if (!movieReleaseColumnNames.includes('radarr_history')) {
      db.exec('ALTER TABLE movie_releases ADD COLUMN radarr_history TEXT');
      console.log('Added column: movie_releases.radarr_history');
    }
    if (!movieReleaseColumnNames.includes('imdb_id')) {
      db.exec('ALTER TABLE movie_releases ADD COLUMN imdb_id TEXT');
      console.log('Added column: movie_releases.imdb_id');
    }
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
  // If new file is at least this much larger than existing, treat as upgrade
  // even if the quality score delta is below upgradeThreshold.
  sizeOnlyUpgradePercent: 25,
};

const defaultAppSettings = {
  pollIntervalMinutes: 60,
  radarrSyncIntervalHours: 6,
  sonarrSyncIntervalHours: 6,
  rssSyncIntervalHours: 1,
};

const existingSettings = db.prepare("SELECT value FROM app_settings WHERE key = 'qualitySettings'").get();
if (!existingSettings) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('qualitySettings', ?)").run(
    JSON.stringify(defaultSettings)
  );
}

const existingAppSettings = db.prepare("SELECT value FROM app_settings WHERE key = 'appSettings'").get();
if (!existingAppSettings) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('appSettings', ?)").run(
    JSON.stringify(defaultAppSettings)
  );
}

const movieReleaseColumns = db.prepare("PRAGMA table_info(movie_releases)").all().map((col: any) => col.name);
if (!movieReleaseColumns.includes('manually_ignored')) {
  db.exec('ALTER TABLE movie_releases ADD COLUMN manually_ignored INTEGER NOT NULL DEFAULT 0');
  console.log('Added column: movie_releases.manually_ignored');
}

const tvReleaseColumns = db.prepare("PRAGMA table_info(tv_releases)").all().map((col: any) => col.name);
if (!tvReleaseColumns.includes('manually_ignored')) {
  db.exec('ALTER TABLE tv_releases ADD COLUMN manually_ignored INTEGER NOT NULL DEFAULT 0');
  console.log('Added column: tv_releases.manually_ignored');
}
if (!tvReleaseColumns.includes('tvdb_slug')) {
  db.exec('ALTER TABLE tv_releases ADD COLUMN tvdb_slug TEXT');
  console.log('Added column: tv_releases.tvdb_slug');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS ignored_shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    show_key TEXT UNIQUE NOT NULL,
    show_name TEXT,
    tvdb_id INTEGER,
    tmdb_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export default db;

