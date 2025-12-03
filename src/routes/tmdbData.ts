import { Router, Request, Response } from 'express';
import { initialTmdbSync, incrementalTmdbSync, getTmdbSyncStatus } from '../services/tmdbSync';
import { syncProgress } from '../services/syncProgress';
import db from '../db';
import { getLanguageName } from '../utils/languageMapping';
import { derivePrimaryCountryFromMovie } from '../utils/tmdbCountryDerivation';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';

const router = Router();

const MOVIES_PER_PAGE = 50;

/**
 * TMDB Data page - List view with pagination and search
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = getTmdbSyncStatus();
    const progress = syncProgress.get();
    const page = parseInt((req.query.page as string) || '1', 10);
    const search = (req.query.search as string) || '';

    // Build query with search
    let query = `SELECT * FROM tmdb_movie_cache WHERE is_deleted = 0`;
    const params: any[] = [];

    if (search) {
      query += ` AND (
        title LIKE ? OR 
        original_title LIKE ? OR 
        original_language LIKE ? OR 
        primary_country LIKE ? OR 
        imdb_id LIKE ? OR 
        tmdb_id LIKE ? OR
        genres LIKE ? OR
        overview LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countQuery = query.replace(/SELECT \*/, 'SELECT COUNT(*) as count');
    const totalResult = db.prepare(countQuery).get(params) as { count: number };
    const total = totalResult.count;
    const totalPages = Math.ceil(total / MOVIES_PER_PAGE);

    // Add pagination
    query += ` ORDER BY title LIMIT ? OFFSET ?`;
    params.push(MOVIES_PER_PAGE, (page - 1) * MOVIES_PER_PAGE);

    const movies = db.prepare(query).all(params) as any[];

    // Enrich with language names
    const enrichedMovies = movies.map(movie => {
      const enriched = { ...movie };
      if (movie.original_language) {
        enriched.original_language_display = getLanguageName(movie.original_language) || movie.original_language;
      }
      // Parse JSON fields
      try {
        if (movie.genres) enriched.genres_parsed = JSON.parse(movie.genres);
        if (movie.production_countries) enriched.production_countries_parsed = JSON.parse(movie.production_countries);
        if (movie.spoken_languages) enriched.spoken_languages_parsed = JSON.parse(movie.spoken_languages);
      } catch (e) {
        // Invalid JSON, ignore
      }
      return enriched;
    });

    // Convert lastSyncDate to ISO string for consistent formatting (like other pages)
    // getTmdbSyncStatus() now handles old format parsing, so we just need to convert to ISO
    let lastSyncDateISO: string | null = null;
    if (status.lastSyncDate) {
      lastSyncDateISO = status.lastSyncDate.toISOString();
    } else {
      // Fallback: check raw database value if Date parsing failed
      const rawSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('tmdb_last_sync_date') as { value: string } | undefined;
      if (rawSetting?.value) {
        const rawValue = rawSetting.value;
        // Handle old format: convert to UTC ISO string
        if (rawValue.includes('T') && rawValue.includes('Z')) {
          lastSyncDateISO = rawValue; // Already ISO
        } else if (rawValue.includes('T')) {
          lastSyncDateISO = rawValue.endsWith('Z') ? rawValue : rawValue + 'Z';
        } else {
          // Old SQLite format: "YYYY-MM-DD HH:MM:SS" - treat as UTC
          lastSyncDateISO = rawValue.replace(' ', 'T') + 'Z';
        }
      }
    }
    
    // Debug: log what we're passing to template
    console.log('[TMDB Data] lastSyncDateISO:', lastSyncDateISO);

    res.render('tmdb-data', {
      currentPage: 'tmdb-data',
      lastSyncDate: lastSyncDateISO,
      totalCached: status.totalCached,
      pendingUpdates: status.pendingUpdates,
      isSyncing: progress?.isRunning && progress?.type === 'tmdb-sync',
      progress: progress || null,
      movies: enrichedMovies,
      currentPageNum: page,
      totalPages,
      total,
      search,
    });
  } catch (error) {
    console.error('TMDB Data page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * TMDB Movie Detail page
 */
router.get('/movie/:tmdbId', async (req: Request, res: Response) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId, 10);
    if (isNaN(tmdbId)) {
      return res.status(400).send('Invalid TMDB ID');
    }

    // Get from cache first
    const cached = db.prepare('SELECT * FROM tmdb_movie_cache WHERE tmdb_id = ? AND is_deleted = 0').get(tmdbId) as any;

    if (!cached) {
      return res.status(404).send('Movie not found in cache');
    }

    // Parse JSON fields
    const movie: any = { ...cached };
    try {
      if (movie.genres) movie.genres_parsed = JSON.parse(movie.genres);
      if (movie.production_countries) movie.production_countries_parsed = JSON.parse(movie.production_countries);
      if (movie.production_companies) movie.production_companies_parsed = JSON.parse(movie.production_companies);
      if (movie.spoken_languages) movie.spoken_languages_parsed = JSON.parse(movie.spoken_languages);
      if (movie.belongs_to_collection) movie.belongs_to_collection_parsed = JSON.parse(movie.belongs_to_collection);
    } catch (e) {
      // Invalid JSON, ignore
    }

    // Enrich with language names
    if (movie.original_language) {
      movie.original_language_display = getLanguageName(movie.original_language) || movie.original_language;
    }

    // Fetch extended data from TMDB API if needed (for detail page)
    let extendedData: any = null;
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
    
    if (tmdbApiKey) {
      try {
        const tmdbClient = new TMDBClient();
        tmdbClient.setApiKey(tmdbApiKey);
        extendedData = await tmdbClient.getMovie(tmdbId, true); // Include extended data
      } catch (error) {
        console.error('Error fetching extended TMDB data:', error);
      }
    }

    res.render('tmdb-movie-detail', {
      currentPage: 'tmdb-data',
      movie,
      extendedData,
    });
  } catch (error) {
    console.error('TMDB Movie Detail page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Start initial TMDB sync
 */
router.post('/sync/initial', async (req: Request, res: Response) => {
  const resume = req.body.resume !== false; // Default to true (resume enabled)
  try {
    // Check if sync is already running
    const progress = syncProgress.get();
    if (progress?.isRunning && progress?.type === 'tmdb-sync') {
      return res.status(400).json({
        success: false,
        error: 'TMDB sync is already in progress',
      });
    }

    // Start sync in background (don't await)
    initialTmdbSync(resume).catch(error => {
      console.error('Background TMDB sync error:', error);
    });

    res.json({
      success: true,
      message: 'Initial TMDB sync started',
    });
  } catch (error: any) {
    console.error('Start initial sync error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to start sync',
    });
  }
});

/**
 * Start incremental TMDB sync
 */
router.post('/sync/incremental', async (req: Request, res: Response) => {
  try {
    // Check if sync is already running
    const progress = syncProgress.get();
    if (progress?.isRunning && progress?.type === 'tmdb-sync') {
      return res.status(400).json({
        success: false,
        error: 'TMDB sync is already in progress',
      });
    }

    // Start sync in background (don't await)
    incrementalTmdbSync().catch(error => {
      console.error('Background TMDB sync error:', error);
    });

    res.json({
      success: true,
      message: 'Incremental TMDB sync started',
    });
  } catch (error: any) {
    console.error('Start incremental sync error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to start sync',
    });
  }
});

/**
 * Get sync progress (for polling)
 */
router.get('/sync/progress', (req: Request, res: Response) => {
  try {
    const progress = syncProgress.get();
    res.json({
      success: true,
      progress: progress || null,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to get progress',
    });
  }
});

/**
 * Refresh a single movie's TMDB data
 */
router.post('/refresh/:tmdbId', async (req: Request, res: Response) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId, 10);
    if (isNaN(tmdbId)) {
      return res.status(400).json({ success: false, error: 'Invalid TMDB ID' });
    }

    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      return res.status(400).json({ success: false, error: 'TMDB API key not configured' });
    }

    tmdbClient.setApiKey(tmdbApiKey);
    const tmdbMovie = await tmdbClient.getMovie(tmdbId);

    if (!tmdbMovie) {
      return res.status(404).json({ success: false, error: 'Movie not found in TMDB' });
    }

    // Derive primary country (stored for backward compatibility, but should be derived at query time)
    const primaryCountry = derivePrimaryCountryFromMovie(tmdbMovie);

    // Update tmdb_movie_cache with all fields including origin_country (maintain consistency with sync logic)
    const existing = db.prepare('SELECT tmdb_id FROM tmdb_movie_cache WHERE tmdb_id = ?').get(tmdbId);
    
    if (existing) {
      // Update existing cache entry
      db.prepare(`
        UPDATE tmdb_movie_cache SET
          title = ?, original_title = ?, original_language = ?, release_date = ?,
          production_countries = ?, origin_country = ?, primary_country = ?, poster_path = ?,
          backdrop_path = ?, overview = ?, tagline = ?, imdb_id = ?,
          genres = ?, production_companies = ?, spoken_languages = ?,
          belongs_to_collection = ?, budget = ?, revenue = ?, runtime = ?,
          popularity = ?, vote_average = ?, vote_count = ?, status = ?,
          adult = ?, video = ?, homepage = ?,
          last_updated_at = datetime('now'), is_deleted = 0
        WHERE tmdb_id = ?
      `).run(
        tmdbMovie.title || null,
        tmdbMovie.original_title || null,
        tmdbMovie.original_language || null,
        tmdbMovie.release_date || null,
        tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
        tmdbMovie.origin_country ? JSON.stringify(tmdbMovie.origin_country) : null,
        primaryCountry,
        tmdbMovie.poster_path || null,
        tmdbMovie.backdrop_path || null,
        tmdbMovie.overview || null,
        tmdbMovie.tagline || null,
        tmdbMovie.imdb_id || null,
        tmdbMovie.genres ? JSON.stringify(tmdbMovie.genres) : null,
        tmdbMovie.production_companies ? JSON.stringify(tmdbMovie.production_companies) : null,
        tmdbMovie.spoken_languages ? JSON.stringify(tmdbMovie.spoken_languages) : null,
        tmdbMovie.belongs_to_collection ? JSON.stringify(tmdbMovie.belongs_to_collection) : null,
        tmdbMovie.budget || null,
        tmdbMovie.revenue || null,
        tmdbMovie.runtime || null,
        tmdbMovie.popularity || null,
        tmdbMovie.vote_average || null,
        tmdbMovie.vote_count || null,
        tmdbMovie.status || null,
        tmdbMovie.adult ? 1 : 0,
        tmdbMovie.video ? 1 : 0,
        tmdbMovie.homepage || null,
        tmdbId
      );
    } else {
      // Insert new cache entry
      db.prepare(`
        INSERT INTO tmdb_movie_cache (
          tmdb_id, title, original_title, original_language, release_date,
          production_countries, origin_country, primary_country, poster_path, backdrop_path,
          overview, tagline, imdb_id, genres, production_companies, spoken_languages,
          belongs_to_collection, budget, revenue, runtime, popularity, vote_average,
          vote_count, status, adult, video, homepage,
          synced_at, last_updated_at, is_deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
      `).run(
        tmdbMovie.id,
        tmdbMovie.title || null,
        tmdbMovie.original_title || null,
        tmdbMovie.original_language || null,
        tmdbMovie.release_date || null,
        tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
        tmdbMovie.origin_country ? JSON.stringify(tmdbMovie.origin_country) : null,
        primaryCountry,
        tmdbMovie.poster_path || null,
        tmdbMovie.backdrop_path || null,
        tmdbMovie.overview || null,
        tmdbMovie.tagline || null,
        tmdbMovie.imdb_id || null,
        tmdbMovie.genres ? JSON.stringify(tmdbMovie.genres) : null,
        tmdbMovie.production_companies ? JSON.stringify(tmdbMovie.production_companies) : null,
        tmdbMovie.spoken_languages ? JSON.stringify(tmdbMovie.spoken_languages) : null,
        tmdbMovie.belongs_to_collection ? JSON.stringify(tmdbMovie.belongs_to_collection) : null,
        tmdbMovie.budget || null,
        tmdbMovie.revenue || null,
        tmdbMovie.runtime || null,
        tmdbMovie.popularity || null,
        tmdbMovie.vote_average || null,
        tmdbMovie.vote_count || null,
        tmdbMovie.status || null,
        tmdbMovie.adult ? 1 : 0,
        tmdbMovie.video ? 1 : 0,
        tmdbMovie.homepage || null
      );
    }

    res.json({
      success: true,
      data: {
        title: tmdbMovie.title,
        original_language: tmdbMovie.original_language,
        primary_country: primaryCountry,
        release_date: tmdbMovie.release_date,
      },
    });
  } catch (error: any) {
    console.error('Refresh TMDB data error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to refresh TMDB data',
    });
  }
});

export default router;

