import { Router, Request, Response } from 'express';
import {
  getMissingImdbMovies,
  getNonIndianMovies,
  getFileNames,
  getFolderNameMismatches,
  getFileNameMismatches,
  getLanguageMismatches,
  getDeletedTitles,
  DataHygieneMovie,
} from '../services/dataHygieneService';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { getLanguageName } from '../utils/languageMapping';
import { getCountryName } from '../utils/countryMapping';
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

    // Extract primary country
    // Extract primary country
    // Priority: production_countries[0].name > origin_country[0] (converted to name) > null
    let primaryCountry: string | null = null;
    if (tmdbMovie.production_countries && tmdbMovie.production_countries.length > 0) {
      primaryCountry = tmdbMovie.production_countries[0].name;
    } else if (tmdbMovie.origin_country && tmdbMovie.origin_country.length > 0) {
      // Fallback to origin_country if production_countries is empty
      primaryCountry = getCountryName(tmdbMovie.origin_country[0]);
    }

    // Update tmdb_movie_cache with all fields (maintain consistency with sync logic)
    const existing = db.prepare('SELECT tmdb_id FROM tmdb_movie_cache WHERE tmdb_id = ?').get(tmdbId);
    
    if (existing) {
      // Update existing cache entry
      db.prepare(`
        UPDATE tmdb_movie_cache SET
          title = ?, original_title = ?, original_language = ?, release_date = ?,
          production_countries = ?, primary_country = ?, poster_path = ?,
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
          production_countries, primary_country, poster_path, backdrop_path,
          overview, tagline, imdb_id, genres, production_companies, spoken_languages,
          belongs_to_collection, budget, revenue, runtime, popularity, vote_average,
          vote_count, status, adult, video, homepage,
          synced_at, last_updated_at, is_deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
      `).run(
        tmdbMovie.id,
        tmdbMovie.title || null,
        tmdbMovie.original_title || null,
        tmdbMovie.original_language || null,
        tmdbMovie.release_date || null,
        tmdbMovie.production_countries ? JSON.stringify(tmdbMovie.production_countries) : null,
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

