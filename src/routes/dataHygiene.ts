import { Router, Request, Response } from 'express';
import path from 'path';
import {
  getMissingImdbMovies,
  getNonIndianMovies,
  getFileNames,
  getFolderNameMismatches,
  getFileNameMismatches,
  getLanguageMismatches,
  getDeletedTitles,
  getPreservedHistory,
  DataHygieneMovie,
  PreservedHistoryEntry,
} from '../services/dataHygieneService';
import { TMDBClient } from '../tmdb/client';
import { RadarrClient } from '../radarr/client';
import { settingsModel } from '../models/settings';
import { getLanguageName } from '../utils/languageMapping';
import { derivePrimaryCountryFromMovie } from '../utils/tmdbCountryDerivation';
import { preserveMovieHistory } from '../services/movieHistoryPreservation';
import { convertLanguageToRadarrFormat } from '../utils/radarrLanguageHelper';
import { syncRadarrMovies } from '../services/radarrSync';
import db from '../db';

const router = Router();

/**
 * Main Data Hygiene page
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const view = (req.query.view as string) || 'missing-imdb';
    const search = (req.query.search as string) || '';

    let movies: DataHygieneMovie[] = [];
    let preservedHistory: PreservedHistoryEntry[] = [];
    let total = 0;

    // Fetch data based on view type
    if (view === 'preserved-history') {
      preservedHistory = getPreservedHistory();
      total = preservedHistory.length;

      // Apply search filter if provided
      if (search) {
        const searchLower = search.toLowerCase();
        preservedHistory = preservedHistory.filter(entry => 
          (entry.title && entry.title.toLowerCase().includes(searchLower)) ||
          (entry.tmdb_id && entry.tmdb_id.toString().includes(searchLower)) ||
          entry.radarr_id.toString().includes(searchLower)
        );
      }

      res.render('data-hygiene', {
        currentPage: 'data-hygiene',
        view,
        preservedHistory,
        total,
        search,
        filteredCount: preservedHistory.length,
      });
      return;
    }

    // Regular movie views
    switch (view) {
      case 'missing-imdb':
        movies = getMissingImdbMovies();
        break;
      case 'non-indian':
        movies = getNonIndianMovies();
        break;
      case 'file-names':
        movies = getFileNames();
        break;
      case 'folder-mismatch':
        movies = getFolderNameMismatches();
        break;
      case 'filename-mismatch':
        movies = getFileNameMismatches();
        break;
      case 'language-mismatch':
        movies = getLanguageMismatches();
        break;
      case 'deleted-titles':
        movies = getDeletedTitles();
        break;
      default:
        movies = getMissingImdbMovies();
    }

    total = movies.length;

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      movies = movies.filter(movie => 
        movie.title.toLowerCase().includes(searchLower) ||
        (movie.year && movie.year.toString().includes(searchLower)) ||
        (movie.imdb_id && movie.imdb_id.toLowerCase().includes(searchLower)) ||
        (movie.tmdb_id && movie.tmdb_id.toString().includes(searchLower)) ||
        (movie.file_name && movie.file_name.toLowerCase().includes(searchLower)) ||
        (movie.folder_name && movie.folder_name.toLowerCase().includes(searchLower))
      );
    }

    // Enrich with language names
    movies = movies.map(movie => {
      const enriched = { ...movie };
      if (movie.original_language) {
        enriched.original_language = getLanguageName(movie.original_language) || movie.original_language;
      }
      if (movie.tmdb_original_language) {
        enriched.tmdb_original_language = getLanguageName(movie.tmdb_original_language) || movie.tmdb_original_language;
      }
      return enriched;
    });

    res.render('data-hygiene', {
      currentPage: 'data-hygiene',
      view,
      movies,
      total,
      search,
      filteredCount: movies.length,
    });
  } catch (error) {
    console.error('Data Hygiene page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Refresh TMDB data for a specific movie
 */
router.post('/refresh-tmdb/:tmdbId', async (req: Request, res: Response) => {
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

    // Also update radarr_movies table with fresh TMDB data
    db.prepare(`
      UPDATE radarr_movies
      SET original_language = ?
      WHERE tmdb_id = ?
    `).run(tmdbMovie.original_language || null, tmdbId);

    // Trigger Radarr scan to pick up the updated TMDB data
    // Find the Radarr ID for this TMDB ID
    const radarrMovie = db.prepare('SELECT radarr_id FROM radarr_movies WHERE tmdb_id = ?').get(tmdbId) as { radarr_id: number } | undefined;
    if (radarrMovie) {
      try {
        const radarrClient = new RadarrClient();
        await radarrClient.refreshMovie(radarrMovie.radarr_id);
        // Wait a moment for Radarr to process
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Trigger Radarr sync to update local DB
        await syncRadarrMovies();
      } catch (radarrError: any) {
        console.error('Failed to trigger Radarr refresh after TMDB update:', radarrError);
        // Continue anyway - TMDB data was updated successfully
      }
    }

    res.json({
      success: true,
      data: {
        title: tmdbMovie.title,
        original_language: tmdbMovie.original_language,
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
 * Scan a movie in Radarr (triggers Radarr to refresh metadata from TMDB)
 * POST /data-hygiene/scan-radarr/:radarrId
 */
router.post('/scan-radarr/:radarrId', async (req: Request, res: Response) => {
  try {
    const radarrId = parseInt(req.params.radarrId, 10);
    if (isNaN(radarrId)) {
      return res.status(400).json({ success: false, error: 'Invalid Radarr ID' });
    }

    const radarrClient = new RadarrClient();
    
    // Step 1: Trigger Radarr refresh
    await radarrClient.refreshMovie(radarrId);
    
    // Step 2: Wait for Radarr to process (2-3 seconds)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 3: Trigger Radarr sync to update local DB
    await syncRadarrMovies();
    
    res.json({
      success: true,
      message: 'Movie scanned in Radarr and local database synced',
    });
  } catch (error: any) {
    console.error('Scan Radarr error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to scan movie in Radarr',
    });
  }
});

/**
 * Mass scan movies in Radarr (batch processing)
 * POST /data-hygiene/mass-scan-radarr
 * Body: { radarrIds: number[] }
 */
router.post('/mass-scan-radarr', async (req: Request, res: Response) => {
  try {
    const { radarrIds } = req.body;
    if (!Array.isArray(radarrIds) || radarrIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or empty radarrIds array' });
    }

    const radarrClient = new RadarrClient();
    const batchSize = 10;
    const delayBetweenBatches = 2000; // 2 seconds
    const results: { radarrId: number; success: boolean; error?: string }[] = [];

    // Process in batches
    for (let i = 0; i < radarrIds.length; i += batchSize) {
      const batch = radarrIds.slice(i, i + batchSize);
      
      // Process batch
      for (const radarrId of batch) {
        try {
          await radarrClient.refreshMovie(radarrId);
          results.push({ radarrId, success: true });
        } catch (error: any) {
          results.push({
            radarrId,
            success: false,
            error: error?.message || 'Failed to refresh movie',
          });
        }
      }
      
      // Wait between batches (except for the last batch)
      if (i + batchSize < radarrIds.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    // Wait a bit for Radarr to process all refreshes
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Trigger Radarr sync to update local DB
    try {
      await syncRadarrMovies();
    } catch (syncError: any) {
      console.error('Failed to sync Radarr after mass scan:', syncError);
      // Continue anyway - individual refreshes may have succeeded
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      message: `Scanned ${successCount} movie(s) in Radarr. ${failureCount} failed.`,
      results,
      summary: {
        total: radarrIds.length,
        successful: successCount,
        failed: failureCount,
      },
    });
  } catch (error: any) {
    console.error('Mass scan Radarr error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to mass scan movies in Radarr',
    });
  }
});

/**
 * Mass refresh TMDB data for multiple movies
 * POST /data-hygiene/mass-refresh-tmdb
 * Body: { tmdbIds: number[] }
 */
router.post('/mass-refresh-tmdb', async (req: Request, res: Response) => {
  try {
    const { tmdbIds } = req.body;
    if (!Array.isArray(tmdbIds) || tmdbIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or empty tmdbIds array' });
    }

    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (!tmdbApiKey) {
      return res.status(400).json({ success: false, error: 'TMDB API key not configured' });
    }

    tmdbClient.setApiKey(tmdbApiKey);
    const radarrClient = new RadarrClient();
    const batchSize = 5; // Smaller batch for TMDB API (rate limiting)
    const delayBetweenBatches = 1000; // 1 second delay
    const results: { tmdbId: number; success: boolean; error?: string }[] = [];
    const radarrIdsToRefresh: number[] = [];

    // Process in batches
    for (let i = 0; i < tmdbIds.length; i += batchSize) {
      const batch = tmdbIds.slice(i, i + batchSize);
      
      // Process batch
      for (const tmdbId of batch) {
        try {
          const tmdbMovie = await tmdbClient.getMovie(tmdbId);
          if (!tmdbMovie) {
            results.push({ tmdbId, success: false, error: 'Movie not found in TMDB' });
            continue;
          }

          const primaryCountry = derivePrimaryCountryFromMovie(tmdbMovie);
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
          } else {
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

          // Update radarr_movies table
          db.prepare(`
            UPDATE radarr_movies
            SET original_language = ?
            WHERE tmdb_id = ?
          `).run(tmdbMovie.original_language || null, tmdbId);

          // Collect Radarr ID for batch refresh
          const radarrMovie = db.prepare('SELECT radarr_id FROM radarr_movies WHERE tmdb_id = ?').get(tmdbId) as { radarr_id: number } | undefined;
          if (radarrMovie) {
            radarrIdsToRefresh.push(radarrMovie.radarr_id);
          }

          results.push({ tmdbId, success: true });
        } catch (error: any) {
          results.push({
            tmdbId,
            success: false,
            error: error?.message || 'Failed to refresh TMDB data',
          });
        }
      }
      
      // Wait between batches (except for the last batch)
      if (i + batchSize < tmdbIds.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    // Trigger Radarr refresh for all updated movies (batch)
    if (radarrIdsToRefresh.length > 0) {
      try {
        // Process Radarr refreshes in batches
        const radarrBatchSize = 10;
        for (let i = 0; i < radarrIdsToRefresh.length; i += radarrBatchSize) {
          const batch = radarrIdsToRefresh.slice(i, i + radarrBatchSize);
          for (const radarrId of batch) {
            try {
              await radarrClient.refreshMovie(radarrId);
            } catch (error) {
              console.error(`Failed to refresh Radarr movie ${radarrId}:`, error);
            }
          }
          if (i + radarrBatchSize < radarrIdsToRefresh.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        // Wait for Radarr to process
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Trigger Radarr sync
        await syncRadarrMovies();
      } catch (radarrError: any) {
        console.error('Failed to trigger Radarr refresh after TMDB update:', radarrError);
        // Continue anyway - TMDB data was updated successfully
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      message: `Refreshed TMDB data for ${successCount} movie(s). ${failureCount} failed.`,
      results,
      summary: {
        total: tmdbIds.length,
        successful: successCount,
        failed: failureCount,
      },
    });
  } catch (error: any) {
    console.error('Mass refresh TMDB error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to mass refresh TMDB data',
    });
  }
});

/**
 * Delete a movie from Radarr
 */
router.post('/delete-movie/:radarrId', async (req: Request, res: Response) => {
  try {
    const radarrId = parseInt(req.params.radarrId, 10);
    if (isNaN(radarrId)) {
      return res.status(400).json({ success: false, error: 'Invalid Radarr ID' });
    }

    const { deleteFiles = false } = req.body;

    const radarrClient = new RadarrClient();
    
    // Delete from Radarr first - only update local DB if Radarr deletion succeeds
    await radarrClient.deleteMovie(radarrId, deleteFiles, false);

    // Only remove from local database if Radarr deletion succeeded
    // This ensures UI consistency - if Radarr deletion fails, the movie stays in the list
    db.prepare('DELETE FROM radarr_movies WHERE radarr_id = ?').run(radarrId);

    res.json({
      success: true,
      message: 'Movie deleted successfully',
    });
  } catch (error: any) {
    console.error('Delete movie error:', error);
    // Do NOT update local database if Radarr deletion failed
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to delete movie',
    });
  }
});

/**
 * Update TMDB ID for a movie without files
 * This is safe because there are no files to preserve.
 * Process: Delete movie → Lookup new TMDB ID → Re-add movie with same settings
 */
router.post('/update-tmdb-id/:radarrId', async (req: Request, res: Response) => {
  try {
    const radarrId = parseInt(req.params.radarrId, 10);
    if (isNaN(radarrId)) {
      return res.status(400).json({ success: false, error: 'Invalid Radarr ID' });
    }

    const { tmdbId } = req.body;
    if (!tmdbId || isNaN(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid TMDB ID' });
    }

    const radarrClient = new RadarrClient();
    
    // Step 1: Get current movie to preserve settings (quality profile, root folder)
    const currentMovie = await radarrClient.getMovie(radarrId);
    if (!currentMovie) {
      return res.status(404).json({ success: false, error: 'Movie not found in Radarr' });
    }

    // Verify movie has no files (safety check)
    if (currentMovie.hasFile) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot update TMDB ID for movies with files. Use Replace instead.' 
      });
    }

    // Get quality profile and root folder
    // Try to preserve root folder from current movie's path, otherwise use defaults
    const qualityProfiles = await radarrClient.getQualityProfiles();
    const rootFolders = await radarrClient.getRootFolders();
    
    // Extract root folder from current movie's path (e.g., /movies/bollywood/Movie Name -> /movies/bollywood)
    // Or match to an existing root folder
    let rootFolderPath = rootFolders[0]?.path || '/movies';
    if (currentMovie.path) {
      // Try to find which root folder this movie's path belongs to
      const matchingFolder = rootFolders.find(folder => currentMovie.path?.startsWith(folder.path));
      if (matchingFolder) {
        rootFolderPath = matchingFolder.path;
      } else {
        // Extract parent directory from path as fallback
        const pathParts = currentMovie.path.split('/').filter(p => p);
        if (pathParts.length > 1) {
          rootFolderPath = '/' + pathParts[0];
        }
      }
    }
    
    // Use first quality profile as default (Radarr doesn't expose quality profile in movie object)
    const qualityProfileId = qualityProfiles.length > 0 ? qualityProfiles[0].id : 1;

    // Step 2: Delete the movie from Radarr (no files to delete)
    await radarrClient.deleteMovie(radarrId, false, false);

    // Step 3: Lookup the new movie by TMDB ID
    const newMovie = await radarrClient.lookupMovieByTmdbId(tmdbId);
    if (!newMovie) {
      return res.status(404).json({ 
        success: false, 
        error: `Movie with TMDB ID ${tmdbId} not found in Radarr lookup` 
      });
    }

    // Step 4: Re-add the movie with the new TMDB ID
    const addedMovie = await radarrClient.addMovie(newMovie, qualityProfileId, rootFolderPath);

    // Step 5: Update local database
    db.prepare('DELETE FROM radarr_movies WHERE radarr_id = ?').run(radarrId);
    
    // The new movie will be picked up in the next Radarr sync, but we can also insert it now
    const dateAdded = (addedMovie as any).added || (addedMovie as any).dateAdded || addedMovie.dateAdded || null;
    db.prepare(`
      INSERT INTO radarr_movies (
        radarr_id, tmdb_id, imdb_id, title, year, path,
        has_file, movie_file, original_language, images, date_added, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      addedMovie.id,
      addedMovie.tmdbId,
      addedMovie.imdbId || null,
      addedMovie.title,
      addedMovie.year || null,
      addedMovie.path || null,
      addedMovie.hasFile ? 1 : 0,
      addedMovie.movieFile ? JSON.stringify(addedMovie.movieFile) : null,
      addedMovie.originalLanguage?.name || null,
      addedMovie.images ? JSON.stringify(addedMovie.images) : null,
      dateAdded,
      new Date().toISOString()
    );

    // Step 6: Refresh TMDB cache for the new TMDB ID
    const tmdbClient = new TMDBClient();
    const allSettings = settingsModel.getAll();
    const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

    if (tmdbApiKey) {
      tmdbClient.setApiKey(tmdbApiKey);
      try {
        const tmdbMovie = await tmdbClient.getMovie(tmdbId);
        if (tmdbMovie) {
          const { derivePrimaryCountryFromMovie } = require('../utils/tmdbCountryDerivation');
          const primaryCountry = derivePrimaryCountryFromMovie(tmdbMovie);

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
          } else {
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
        }
      } catch (tmdbError) {
        console.error('Failed to refresh TMDB data after update:', tmdbError);
        // Continue anyway - the Radarr update succeeded
      }
    }

    res.json({
      success: true,
      message: 'TMDB ID updated successfully',
      newRadarrId: addedMovie.id,
    });
  } catch (error: any) {
    console.error('Update TMDB ID error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update TMDB ID',
    });
  }
});

/**
 * Replace TMDB ID for a movie with files
 * Process: Preserve history → Delete movie (keep files) → Add new movie → Manual Import existing file
 */
router.post('/replace-tmdb-id/:radarrId', async (req: Request, res: Response) => {
  try {
    const radarrId = parseInt(req.params.radarrId, 10);
    if (isNaN(radarrId)) {
      return res.status(400).json({ success: false, error: 'Invalid Radarr ID' });
    }

    const { tmdbId } = req.body;
    if (!tmdbId || isNaN(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid TMDB ID' });
    }

    const radarrClient = new RadarrClient();
    
    // Step 1: Get current movie to preserve settings and file info
    const currentMovie = await radarrClient.getMovie(radarrId);
    if (!currentMovie) {
      return res.status(404).json({ success: false, error: 'Movie not found in Radarr' });
    }

    // Verify movie has files (safety check)
    if (!currentMovie.hasFile || !currentMovie.movieFile) {
      return res.status(400).json({ 
        success: false, 
        error: 'Movie has no files. Use Update instead of Replace.' 
      });
    }

    // Step 2: Preserve history before deletion
    try {
      await preserveMovieHistory(radarrId);
    } catch (historyError) {
      console.error('Failed to preserve history (continuing anyway):', historyError);
      // Continue - history preservation failure shouldn't block the operation
    }

    // Step 3: Extract file information
    const movieFile = currentMovie.movieFile!;
    const fullFilePath = `${currentMovie.path}/${movieFile.relativePath}`;
    
    // Extract quality info from movieFile (Radarr will auto-detect, but we can provide it)
    const qualityInfo = movieFile.quality || undefined;
    
    // Get language from stored original_language in our DB
    const storedMovie = db.prepare('SELECT original_language FROM radarr_movies WHERE radarr_id = ?').get(radarrId) as { original_language: string | null } | undefined;
    const languageName = storedMovie?.original_language || currentMovie.originalLanguage?.name || null;
    const languages = convertLanguageToRadarrFormat(languageName);

    // Step 4: Extract root folder from current movie path
    const qualityProfiles = await radarrClient.getQualityProfiles();
    const rootFolders = await radarrClient.getRootFolders();
    
    let rootFolderPath = rootFolders[0]?.path || '/movies';
    if (currentMovie.path) {
      const matchingFolder = rootFolders.find(folder => currentMovie.path?.startsWith(folder.path));
      if (matchingFolder) {
        rootFolderPath = matchingFolder.path;
      } else {
        const pathParts = currentMovie.path.split('/').filter(p => p);
        if (pathParts.length > 1) {
          rootFolderPath = '/' + pathParts[0];
        }
      }
    }
    
    const qualityProfileId = qualityProfiles.length > 0 ? qualityProfiles[0].id : 1;

    // Step 5: Delete movie (preserve files)
    await radarrClient.deleteMovie(radarrId, false, false);

    // Step 6: Lookup new movie by new TMDB ID to get movie metadata
    const newMovie = await radarrClient.lookupMovieByTmdbId(tmdbId);
    if (!newMovie) {
      return res.status(404).json({ 
        success: false, 
        error: `Movie with TMDB ID ${tmdbId} not found in Radarr lookup` 
      });
    }

    // Step 7: Add new movie first (so it exists in Radarr)
    const addedMovie = await radarrClient.addMovie(newMovie, qualityProfileId, rootFolderPath);
    
    // Step 7.5: Wait a moment for Radarr to process, then fetch the movie to get its ID
    await new Promise(resolve => setTimeout(resolve, 1000));
    let newMovieId = addedMovie.id;
    if (!newMovieId || newMovieId === 0) {
      // Fetch by TMDB ID if ID not in response
      const fetchedMovie = await radarrClient.getMovie(tmdbId);
      if (!fetchedMovie || !fetchedMovie.id) {
        return res.status(500).json({
          success: false,
          error: 'Movie was added but could not retrieve the new movie ID. Please check Radarr.',
        });
      }
      newMovieId = fetchedMovie.id;
    }
    console.log(`[Replace] New movie added with ID: ${newMovieId}`);

    // Step 8: Use Manual Import API (GET then POST) to link the existing file
    // GET /api/v3/manualimport?folder=<folder> to get file listing
    // POST /api/v3/manualimport with file data + movieId to import
    try {
      // Use the folder where the file actually exists (old movie's folder)
      const fileFolder = currentMovie.path || path.dirname(fullFilePath);
      
      console.log(`[Replace] Getting manual import files from folder: ${fileFolder}`);
      
      // Step 8.1: GET manual import files
      const importFiles = await radarrClient.getManualImportFiles(fileFolder, false);
      
      // Step 8.2: Find our file in the response
      const fileToImport = importFiles.find((file: any) => file.path === fullFilePath);
      if (!fileToImport) {
        return res.status(404).json({
          success: false,
          error: `File not found in manual import listing: ${fullFilePath}. The file may not be accessible or may have been moved.`,
        });
      }
      
      console.log(`[Replace] Found file in manual import listing:`, JSON.stringify(fileToImport, null, 2));
      
      // Step 8.3: Update file object with new movie ID and set imported flag
      const importPayload = [{
        ...fileToImport,
        movie: {
          ...fileToImport.movie,
          id: newMovieId,
          tmdbId: tmdbId,
        },
        movieId: newMovieId,
        imported: true,
      }];
      
      console.log(`[Replace] Posting manual import with movieId: ${newMovieId}`);
      
      // Step 8.4: POST manual import
      await radarrClient.manualImport(importPayload);
      
      console.log(`[Replace] Manual import completed successfully`);
      
      // Step 8.5: Fetch the movie again to get updated file info after import
      await new Promise(resolve => setTimeout(resolve, 1000));
      const updatedMovie = await radarrClient.getMovie(newMovieId);
      if (!updatedMovie) {
        return res.status(500).json({
          success: false,
          error: 'Manual import completed but could not fetch updated movie data.',
        });
      }
      
      // Step 9: Update local database
      db.prepare('DELETE FROM radarr_movies WHERE radarr_id = ?').run(radarrId);
      
      // Insert new movie (will be synced properly on next sync, but we can insert now)
      const dateAdded = updatedMovie.added || updatedMovie.dateAdded || addedMovie.added || addedMovie.dateAdded || null;
      db.prepare(`
        INSERT INTO radarr_movies (
          radarr_id, tmdb_id, imdb_id, title, year, path,
          has_file, movie_file, original_language, images, date_added, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newMovieId,
        updatedMovie.tmdbId || addedMovie.tmdbId,
        updatedMovie.imdbId || addedMovie.imdbId || null,
        updatedMovie.title || addedMovie.title,
        updatedMovie.year || addedMovie.year || null,
        updatedMovie.path || addedMovie.path || null,
        updatedMovie.hasFile ? 1 : 0,
        updatedMovie.movieFile ? JSON.stringify(updatedMovie.movieFile) : null,
        updatedMovie.originalLanguage?.name || addedMovie.originalLanguage?.name || null,
        updatedMovie.images ? JSON.stringify(updatedMovie.images) : null,
        dateAdded,
        new Date().toISOString()
      );

      // Step 9: Refresh TMDB cache for new TMDB ID
      const tmdbClient = new TMDBClient();
      const allSettings = settingsModel.getAll();
      const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

      if (tmdbApiKey) {
        tmdbClient.setApiKey(tmdbApiKey);
        try {
          const tmdbMovie = await tmdbClient.getMovie(tmdbId);
          if (tmdbMovie) {
            const primaryCountry = derivePrimaryCountryFromMovie(tmdbMovie);
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
            } else {
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
          }
        } catch (tmdbError) {
          console.error('Failed to refresh TMDB data after replace:', tmdbError);
          // Continue anyway - the Radarr operation succeeded
        }
      }

      res.json({
        success: true,
        message: 'TMDB ID replaced successfully. File has been linked to the new movie entry.',
        newRadarrId: newMovieId,
      });
    } catch (importError: any) {
      console.error('Manual import failed:', importError);
      return res.status(500).json({
        success: false,
        error: `Manual Import failed: ${importError.message}. The file may need to be manually imported in Radarr.`,
      });
    }
  } catch (error: any) {
    console.error('Replace TMDB ID error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to replace TMDB ID',
    });
  }
});

/**
 * Get preserved history details by ID
 */
router.get('/history/:historyId', (req: Request, res: Response) => {
  try {
    const historyId = parseInt(req.params.historyId, 10);
    if (isNaN(historyId)) {
      return res.status(400).json({ success: false, error: 'Invalid history ID' });
    }

    const row = db
      .prepare('SELECT history_data FROM radarr_movie_history WHERE id = ?')
      .get(historyId) as { history_data: string } | undefined;

    if (!row) {
      return res.status(404).json({ success: false, error: 'History not found' });
    }

    try {
      const history = JSON.parse(row.history_data);
      res.json({ success: true, history });
    } catch (parseError) {
      res.status(500).json({ success: false, error: 'Failed to parse history data' });
    }
  } catch (error: any) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to get history' });
  }
});

export default router;

