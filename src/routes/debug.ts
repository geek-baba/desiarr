import { Router, Request, Response } from 'express';
import { RadarrClient } from '../radarr/client';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { getLanguageName } from '../utils/languageMapping';
import db from '../db';

const router = Router();

/**
 * Debug page - compare movie data from Radarr API, TMDB API, and local DB
 * GET /debug?tmdbId=12345
 */
router.get('/', async (req: Request, res: Response) => {
  const tmdbId = req.query.tmdbId ? parseInt(req.query.tmdbId as string, 10) : null;
  
  res.render('debug', {
    currentPage: 'debug',
    tmdbId: tmdbId || null,
  });
});

/**
 * API endpoint to fetch and compare movie data
 * GET /debug/api/movie?tmdbId=12345
 */
router.get('/api/movie', async (req: Request, res: Response) => {
  try {
    const tmdbId = req.query.tmdbId ? parseInt(req.query.tmdbId as string, 10) : null;
    
    if (!tmdbId || isNaN(tmdbId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'TMDB ID is required' 
      });
    }

    const result: any = {
      success: true,
      tmdbId,
      radarr: null,
      tmdb: null,
      localDb: null,
      errors: [],
    };

    // 1. Fetch from Radarr API
    try {
      const radarrClient = new RadarrClient();
      // Try to find movie by TMDB ID in Radarr
      let radarrMovie = null;
      
      // First, check local DB for radarr_id
      const localRadarrMovie = db.prepare('SELECT radarr_id FROM radarr_movies WHERE tmdb_id = ?')
        .get(tmdbId) as { radarr_id: number } | undefined;
      
      if (localRadarrMovie?.radarr_id) {
        // Try to get by Radarr ID first
        radarrMovie = await radarrClient.getMovie(localRadarrMovie.radarr_id);
      }
      
      // If not found, try to get by TMDB ID using Radarr's lookup
      // Note: getMovie() tries Radarr ID first, then falls back to TMDB ID lookup
      // But we need to be careful - if tmdbId is a small number, it might be mistaken for Radarr ID
      if (!radarrMovie && tmdbId > 1000) {
        // Only try direct lookup if TMDB ID is large enough to not be confused with Radarr ID
        try {
          const lookupResult = await radarrClient.getMovie(tmdbId);
          // Verify it's the right movie
          if (lookupResult && lookupResult.tmdbId === tmdbId) {
            radarrMovie = lookupResult;
          }
        } catch (error) {
          // getMovie failed, will try getAllMovies as last resort below
        }
      }
      
      // Last resort: search all movies (slow but comprehensive)
      // Only do this if we still don't have the movie
      if (!radarrMovie) {
        console.log(`[Debug] Movie ${tmdbId} not found via direct lookup, searching all movies...`);
        const radarrMovies = await radarrClient.getAllMovies();
        radarrMovie = radarrMovies.find(m => m.tmdbId === tmdbId) || null;
      }
      
      if (radarrMovie) {
        result.radarr = {
          radarrId: radarrMovie.id || null,
          title: radarrMovie.title || null,
          year: radarrMovie.year || null,
          tmdbId: radarrMovie.tmdbId || null,
          imdbId: radarrMovie.imdbId || null,
          originalLanguage: radarrMovie.originalLanguage?.name || null,
          originalLanguageId: radarrMovie.originalLanguage?.id || null,
          path: radarrMovie.path || null,
          hasFile: radarrMovie.hasFile || false,
          fileLanguage: radarrMovie.movieFile?.language?.name || null,
          fileLanguageId: radarrMovie.movieFile?.language?.id || null,
          mediaInfoAudioLanguages: radarrMovie.movieFile?.mediaInfo?.audioLanguages || null,
          dateAdded: (radarrMovie as any).added || radarrMovie.dateAdded || null,
        };
      } else {
        result.errors.push('Movie not found in Radarr');
      }
    } catch (error: any) {
      result.errors.push(`Radarr API error: ${error?.message || 'Unknown error'}`);
    }

    // 2. Fetch from TMDB API
    try {
      const tmdbClient = new TMDBClient();
      const tmdbApiKey = settingsModel.get('tmdb_api_key');
      
      if (tmdbApiKey) {
        tmdbClient.setApiKey(tmdbApiKey);
        const tmdbMovie = await tmdbClient.getMovie(tmdbId);
        
        if (tmdbMovie) {
          result.tmdb = {
            tmdbId: tmdbMovie.id || null,
            title: tmdbMovie.title || null,
            originalTitle: tmdbMovie.original_title || null,
            year: tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : null,
            originalLanguage: tmdbMovie.original_language || null,
            originalLanguageName: tmdbMovie.original_language ? getLanguageName(tmdbMovie.original_language) : null,
            releaseDate: tmdbMovie.release_date || null,
            overview: tmdbMovie.overview || null,
            imdbId: tmdbMovie.imdb_id || null,
          };
        } else {
          result.errors.push('Movie not found in TMDB API');
        }
      } else {
        result.errors.push('TMDB API key not configured');
      }
    } catch (error: any) {
      result.errors.push(`TMDB API error: ${error?.message || 'Unknown error'}`);
    }

    // 3. Fetch from local database
    try {
      // Get from radarr_movies table
      const radarrMovieDb = db.prepare('SELECT * FROM radarr_movies WHERE tmdb_id = ?')
        .get(tmdbId) as any;
      
      // Get from tmdb_movie_cache table
      const tmdbCache = db.prepare('SELECT * FROM tmdb_movie_cache WHERE tmdb_id = ?')
        .get(tmdbId) as any;

      if (radarrMovieDb || tmdbCache) {
        result.localDb = {
          radarr: radarrMovieDb ? {
            radarrId: radarrMovieDb.radarr_id || null,
            title: radarrMovieDb.title || null,
            year: radarrMovieDb.year || null,
            tmdbId: radarrMovieDb.tmdb_id || null,
            imdbId: radarrMovieDb.imdb_id || null,
            originalLanguage: radarrMovieDb.original_language || null,
            path: radarrMovieDb.path || null,
            hasFile: radarrMovieDb.has_file === 1,
            dateAdded: radarrMovieDb.date_added || null,
            syncedAt: radarrMovieDb.synced_at || null,
            movieFile: radarrMovieDb.movie_file ? JSON.parse(radarrMovieDb.movie_file) : null,
          } : null,
          tmdb: tmdbCache ? {
            tmdbId: tmdbCache.tmdb_id || null,
            title: tmdbCache.title || null,
            originalTitle: tmdbCache.original_title || null,
            originalLanguage: tmdbCache.original_language || null,
            originalLanguageName: tmdbCache.original_language ? getLanguageName(tmdbCache.original_language) : null,
            releaseDate: tmdbCache.release_date || null,
            syncedAt: tmdbCache.synced_at || null,
          } : null,
        };
      } else {
        result.errors.push('Movie not found in local database');
      }
    } catch (error: any) {
      result.errors.push(`Database error: ${error?.message || 'Unknown error'}`);
    }

    res.json(result);
  } catch (error: any) {
    console.error('Debug API error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch debug data',
    });
  }
});

export default router;

