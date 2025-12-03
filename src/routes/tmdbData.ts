import { Router, Request, Response } from 'express';
import { initialTmdbSync, incrementalTmdbSync, getTmdbSyncStatus } from '../services/tmdbSync';
import { syncProgress } from '../services/syncProgress';
import db from '../db';
import { getLanguageName } from '../utils/languageMapping';
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

    // Format lastSyncDate to EST if it exists
    let formattedLastSyncDate: string | null = null;
    if (status.lastSyncDate) {
      try {
        // Parse the date (handles both YYYY-MM-DD and YYYY-MM-DD HH:MM:SS formats)
        const dateStr = status.lastSyncDate.includes(' ') ? status.lastSyncDate : `${status.lastSyncDate}T00:00:00`;
        const date = new Date(dateStr);
        // Format to EST (America/New_York timezone)
        formattedLastSyncDate = date.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        }) + ' EST';
      } catch (error) {
        // If parsing fails, use the raw value
        formattedLastSyncDate = status.lastSyncDate;
      }
    }

    res.render('tmdb-data', {
      currentPage: 'tmdb-data',
      lastSyncDate: formattedLastSyncDate,
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

export default router;

