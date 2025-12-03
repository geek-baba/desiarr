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

/**
 * Backfill page - List movies with missing fields
 */
router.get('/backfill', async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) || '1', 10);
    const missing = (req.query.missing as string) || 'origin_country';
    const search = (req.query.search as string) || '';

    console.log('[TMDB Backfill] Query params:', { missing, search, page });

    // Build query to find movies with missing field
    let query = `SELECT * FROM tmdb_movie_cache WHERE is_deleted = 0`;
    const params: any[] = [];

    // Filter by missing field
    switch (missing) {
      case 'origin_country':
        // origin_country is stored as JSON array string, e.g., '["IN"]' or '[]'
        // We need to check if it's NULL, empty string, or an empty JSON array
        // Since SQLite doesn't have native JSON parsing, we check for:
        // - NULL
        // - Empty string
        // - '[]' (empty array)
        // - 'null' (JSON null)
        // - Any string that when parsed is an empty array
        // For now, we'll use a simple check and validate in JavaScript
        query += ` AND (origin_country IS NULL OR origin_country = '' OR origin_country = '[]' OR origin_country = 'null')`;
        break;
      case 'release_date':
        query += ` AND (release_date IS NULL OR release_date = '')`;
        break;
      case 'overview':
        query += ` AND (overview IS NULL OR overview = '')`;
        break;
      case 'tagline':
        query += ` AND (tagline IS NULL OR tagline = '')`;
        break;
      case 'homepage':
        query += ` AND (homepage IS NULL OR homepage = '')`;
        break;
      case 'primary_country':
        // primary_country can be NULL, empty, or '-' (placeholder)
        // Show movies where primary_country is missing (we'll derive it in enrichment if possible)
        query += ` AND (primary_country IS NULL OR primary_country = '' OR primary_country = '-')`;
        break;
      default:
        query += ` AND (origin_country IS NULL OR origin_country = '' OR origin_country = '[]')`;
    }

    console.log('[TMDB Backfill] Query:', query);

    // Add search filter
    if (search) {
      query += ` AND (
        title LIKE ? OR 
        original_title LIKE ? OR 
        tmdb_id LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    // For origin_country, we need to validate ALL movies first, then paginate
    // For other fields, use standard SQL count
    let total = 0;
    let totalPages = 0;
    let movies: any[] = [];
    
    if (missing === 'origin_country') {
      // Query ALL movies matching the SQL criteria (no pagination yet)
      // Build query without ORDER BY and LIMIT/OFFSET
      let allMoviesQuery = query;
      const allMovies = db.prepare(allMoviesQuery).all(params) as any[];
      
      console.log('[TMDB Backfill] Total movies from SQL query:', allMovies.length);
      
      // Filter in JavaScript to get accurate list of movies actually missing origin_country
      // IMPORTANT: We check origin_country field itself, NOT primary_country (which can be derived)
      let sampleChecked = 0;
      let sampleWithOriginCountry = 0;
      const validMovies = allMovies.filter(movie => {
        sampleChecked++;
        if (sampleChecked <= 5) {
          console.log(`[TMDB Backfill] Sample movie ${sampleChecked}: tmdb_id=${movie.tmdb_id}, origin_country="${movie.origin_country}", primary_country="${movie.primary_country}"`);
        }
        
        // Check if origin_country exists and has data
        if (movie.origin_country) {
          try {
            const originCountry = JSON.parse(movie.origin_country);
            // If it's a valid array with at least one element, exclude it
            if (Array.isArray(originCountry) && originCountry.length > 0) {
              sampleWithOriginCountry++;
              if (sampleChecked <= 5) {
                console.log(`[TMDB Backfill] Sample movie ${sampleChecked} HAS origin_country:`, originCountry);
              }
              return false; // Has origin_country, exclude
            }
          } catch (e) {
            // Invalid JSON, treat as missing (include)
            if (sampleChecked <= 5) {
              console.log(`[TMDB Backfill] Sample movie ${sampleChecked} has invalid JSON:`, e instanceof Error ? e.message : String(e));
            }
          }
        }
        // No origin_country or empty array, include in results
        return true;
      });
      
      console.log(`[TMDB Backfill] Sample check: ${sampleChecked} movies checked, ${sampleWithOriginCountry} had origin_country`);
      
      // Sort by title
      validMovies.sort((a, b) => {
        const titleA = (a.title || '').toLowerCase();
        const titleB = (b.title || '').toLowerCase();
        return titleA.localeCompare(titleB);
      });
      
      total = validMovies.length;
      totalPages = Math.ceil(total / MOVIES_PER_PAGE);
      
      // Apply pagination to filtered results
      const startIndex = (page - 1) * MOVIES_PER_PAGE;
      const endIndex = startIndex + MOVIES_PER_PAGE;
      movies = validMovies.slice(startIndex, endIndex);
      
      console.log('[TMDB Backfill] Total movies after validation:', total);
      console.log('[TMDB Backfill] Movies filtered out:', allMovies.length - total);
      console.log('[TMDB Backfill] Movies on current page:', movies.length);
    } else {
      // For other fields, use standard SQL approach
      const countQuery = query.replace(/SELECT \*/, 'SELECT COUNT(*) as count');
      const totalResult = db.prepare(countQuery).get(params) as { count: number };
      total = totalResult.count;
      totalPages = Math.ceil(total / MOVIES_PER_PAGE);
      
      console.log('[TMDB Backfill] Query:', query);
      console.log('[TMDB Backfill] Params:', params);
      console.log('[TMDB Backfill] Total movies found:', total);

      // Add pagination
      query += ` ORDER BY title LIMIT ? OFFSET ?`;
      params.push(MOVIES_PER_PAGE, (page - 1) * MOVIES_PER_PAGE);

      movies = db.prepare(query).all(params) as any[];
    }

    // Enrich with language names and derive primary_country if missing
    const enrichedMovies = movies.map(movie => {
      const enriched = { ...movie };
      if (movie.original_language) {
        enriched.original_language_display = getLanguageName(movie.original_language) || movie.original_language;
      }
      
      // Derive primary_country if it's missing but we have production_countries or origin_country
      if (!enriched.primary_country || enriched.primary_country === '' || enriched.primary_country === '-') {
        try {
          const productionCountries = movie.production_countries ? JSON.parse(movie.production_countries) : null;
          const originCountry = movie.origin_country ? JSON.parse(movie.origin_country) : null;
          if (productionCountries && productionCountries.length > 0) {
            enriched.primary_country = productionCountries[0].name;
          } else if (originCountry && originCountry.length > 0) {
            // Use country mapping utility
            const { getCountryName } = require('../utils/countryMapping');
            enriched.primary_country = getCountryName(originCountry[0]) || originCountry[0];
          }
        } catch (e) {
          // Invalid JSON, ignore
        }
      }
      return enriched;
    });

    console.log('[TMDB Backfill] Enriched movies count:', enrichedMovies.length);

    res.render('tmdb-data', {
      currentPage: 'tmdb-data',
      view: 'backfill',
      missingField: missing,
      movies: enrichedMovies,
      currentPageNum: page,
      totalPages,
      total,
      search,
      lastSyncDate: null,
      totalCached: 0,
      pendingUpdates: 0,
      isSyncing: false,
      progress: null,
      selectAllTotal: total, // Total across all pages for "Select All" functionality
    });
  } catch (error) {
    console.error('Backfill page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Get all TMDB IDs for movies matching the missing field filter (for "Select All" across pages)
 */
router.get('/backfill/ids', async (req: Request, res: Response) => {
  try {
    const missing = (req.query.missing as string) || 'origin_country';

    // Build query to find movies with missing field (same logic as main backfill route)
    let query = `SELECT tmdb_id FROM tmdb_movie_cache WHERE is_deleted = 0`;
    const params: any[] = [];

    // Filter by missing field (same switch as main route)
    switch (missing) {
      case 'origin_country':
        query += ` AND (origin_country IS NULL OR origin_country = '' OR origin_country = '[]' OR origin_country = 'null')`;
        break;
      case 'release_date':
        query += ` AND (release_date IS NULL OR release_date = '')`;
        break;
      case 'overview':
        query += ` AND (overview IS NULL OR overview = '')`;
        break;
      case 'tagline':
        query += ` AND (tagline IS NULL OR tagline = '')`;
        break;
      case 'homepage':
        query += ` AND (homepage IS NULL OR homepage = '')`;
        break;
      case 'primary_country':
        query += ` AND (primary_country IS NULL OR primary_country = '' OR primary_country = '-')`;
        break;
      default:
        query += ` AND (origin_country IS NULL OR origin_country = '' OR origin_country = '[]' OR origin_country = 'null')`;
    }

    // For origin_country, validate all movies first
    if (missing === 'origin_country') {
      const allMovies = db.prepare(query).all(params) as any[];
      const validIds = allMovies
        .filter(movie => {
          // Check if origin_country exists and has data (not derived primary_country)
          if (movie.origin_country) {
            try {
              const originCountry = JSON.parse(movie.origin_country);
              // If it's a valid array with at least one element, exclude it
              if (Array.isArray(originCountry) && originCountry.length > 0) {
                return false; // Has origin_country, exclude
              }
            } catch (e) {
              // Invalid JSON, treat as missing (include)
            }
          }
          // No origin_country or empty array, include
          return true;
        })
        .map(movie => movie.tmdb_id) as number[];
      
      console.log('[TMDB Backfill IDs] Total movies from SQL:', allMovies.length);
      console.log('[TMDB Backfill IDs] Valid IDs after validation:', validIds.length);
      res.json({ success: true, ids: validIds });
    } else {
      const movies = db.prepare(query).all(params) as any[];
      const validIds = movies.map(movie => movie.tmdb_id) as number[];
      console.log('[TMDB Backfill IDs] Total IDs found:', validIds.length);
      res.json({ success: true, ids: validIds });
    }
  } catch (error) {
    console.error('Backfill IDs error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Bulk backfill selected movies
 */
router.post('/backfill', async (req: Request, res: Response) => {
  try {
    const { tmdbIds, missingField } = req.body;

    if (!Array.isArray(tmdbIds) || tmdbIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No movies selected for backfill',
      });
    }

    if (!missingField) {
      return res.status(400).json({
        success: false,
        error: 'Missing field not specified',
      });
    }

    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      return res.status(400).json({
        success: false,
        error: 'TMDB API key not configured',
      });
    }

    tmdbClient.setApiKey(tmdbApiKey);

    // Start progress tracking
    const jobId = `backfill-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    syncProgress.start('tmdb-backfill', tmdbIds.length);
    syncProgress.update(`Starting backfill for ${tmdbIds.length} movies...`, 0);

    // Process in background
    (async () => {
      let processed = 0;
      let updated = 0;
      let errors = 0;
      const errorDetails: string[] = [];

      for (let i = 0; i < tmdbIds.length; i++) {
        const tmdbId = parseInt(tmdbIds[i], 10);
        if (isNaN(tmdbId)) {
          errors++;
          errorDetails.push(`Invalid TMDB ID: ${tmdbIds[i]}`);
          processed++;
          continue;
        }

        try {
          // Rate limiting: 3 requests per second (333ms delay)
          if (i > 0 && i % 3 === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          const tmdbMovie = await tmdbClient.getMovie(tmdbId);

          if (!tmdbMovie) {
            errors++;
            errorDetails.push(`Movie ${tmdbId} not found in TMDB`);
            processed++;
            syncProgress.update(`Processing ${processed}/${tmdbIds.length}...`, processed, tmdbIds.length, errors);
            continue;
          }

          // Derive primary country
          const primaryCountry = derivePrimaryCountryFromMovie(tmdbMovie);

          // Update cache
          const existing = db.prepare('SELECT tmdb_id FROM tmdb_movie_cache WHERE tmdb_id = ?').get(tmdbId);

          if (existing) {
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
            updated++;
          } else {
            // Insert new entry
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
            updated++;
          }

          processed++;
          syncProgress.update(
            `Processed ${processed}/${tmdbIds.length} movies (${updated} updated, ${errors} errors)...`,
            processed,
            tmdbIds.length,
            errors
          );
        } catch (error: any) {
          errors++;
          errorDetails.push(`Movie ${tmdbId}: ${error?.message || 'Unknown error'}`);
          processed++;
          syncProgress.update(
            `Processed ${processed}/${tmdbIds.length} movies (${updated} updated, ${errors} errors)...`,
            processed,
            tmdbIds.length,
            errors
          );
        }
      }

      syncProgress.complete();
    })().catch(error => {
      console.error('Background backfill error:', error);
      syncProgress.error('Backfill failed: ' + (error?.message || 'Unknown error'));
    });

    res.json({
      success: true,
      message: `Backfill started for ${tmdbIds.length} movies`,
      jobId,
    });
  } catch (error: any) {
    console.error('Backfill error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to start backfill',
    });
  }
});

export default router;

