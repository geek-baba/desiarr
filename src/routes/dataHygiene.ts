import { Router, Request, Response } from 'express';
import {
  getMissingImdbMovies,
  getNonIndianMovies,
  getFileNames,
  getFolderNameMismatches,
  getFileNameMismatches,
  getLanguageMismatches,
  DataHygieneMovie,
} from '../services/dataHygieneService';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { getLanguageName } from '../utils/languageMapping';
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
    let total = 0;

    // Fetch data based on view type
    switch (view) {
      case 'missing-imdb':
        movies = getMissingImdbMovies();
        break;
      case 'non-indian':
        movies = await getNonIndianMovies();
        break;
      case 'file-names':
        movies = getFileNames();
        break;
      case 'folder-mismatch':
        movies = await getFolderNameMismatches();
        break;
      case 'filename-mismatch':
        movies = await getFileNameMismatches();
        break;
      case 'language-mismatch':
        movies = await getLanguageMismatches();
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
        (movie.tmdb_id && movie.tmdb_id.toString().includes(searchLower))
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

    // Update radarr_movies table with fresh TMDB data
    db.prepare(`
      UPDATE radarr_movies
      SET original_language = ?
      WHERE tmdb_id = ?
    `).run(tmdbMovie.original_language || null, tmdbId);

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

export default router;

