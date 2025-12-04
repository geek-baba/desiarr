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
  DataHygieneMovie,
} from '../services/dataHygieneService';
import { TMDBClient } from '../tmdb/client';
import { RadarrClient } from '../radarr/client';
import { settingsModel } from '../models/settings';
import { getLanguageName } from '../utils/languageMapping';
import { derivePrimaryCountryFromMovie } from '../utils/tmdbCountryDerivation';
import { preserveMovieHistory } from '../services/movieHistoryPreservation';
import { convertLanguageToRadarrFormat } from '../utils/radarrLanguageHelper';
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

    // Step 7: Use Manual Import to CREATE the new movie and import the file in one step
    // Manual Import creates the movie entry if it doesn't exist
    // Use movieId: 0 to indicate "create new movie" (Radarr will create it based on TMDB ID from file/folder)
    let newMovieId: number;
    try {
      // Use the folder where the file actually exists (old movie's folder)
      const fileFolder = currentMovie.path || path.dirname(fullFilePath);
      
      console.log(`[Replace] Calling Manual Import to create movie with TMDB ID ${tmdbId} and import file: ${fullFilePath}`);
      
      // Manual Import with movieId: 0 should create a new movie
      // The files array should include the TMDB ID information
      await radarrClient.manualImport({
        movieId: 0, // 0 indicates "create new movie" - Radarr will match by file/folder or we need to pass TMDB ID
        files: [{
          path: fullFilePath,
          quality: qualityInfo,
          languages: languages,
          // Add TMDB ID to the file object if Radarr API supports it
          // Otherwise, Radarr should match by folder name or we need a different approach
        }],
        folder: fileFolder,
        importMode: 'Auto',
      });
      
      // Step 7.5: Wait a moment for Radarr to process, then fetch the newly created movie
      await new Promise(resolve => setTimeout(resolve, 2000));
      const createdMovie = await radarrClient.getMovie(tmdbId);
      if (!createdMovie || !createdMovie.id) {
        return res.status(500).json({
          success: false,
          error: 'Manual Import completed but could not retrieve the new movie ID. Please check Radarr.',
        });
      }
      newMovieId = createdMovie.id;
      console.log(`[Replace] Movie created with ID: ${newMovieId}`);
      
      // Step 8: Update local database
      db.prepare('DELETE FROM radarr_movies WHERE radarr_id = ?').run(radarrId);
      
      // Insert new movie (will be synced properly on next sync, but we can insert now)
      const dateAdded = createdMovie.added || createdMovie.dateAdded || null;
      db.prepare(`
        INSERT INTO radarr_movies (
          radarr_id, tmdb_id, imdb_id, title, year, path,
          has_file, movie_file, original_language, images, date_added, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newMovieId,
        createdMovie.tmdbId,
        createdMovie.imdbId || null,
        createdMovie.title,
        createdMovie.year || null,
        createdMovie.path || null,
        createdMovie.hasFile ? 1 : 0,
        createdMovie.movieFile ? JSON.stringify(createdMovie.movieFile) : null,
        createdMovie.originalLanguage?.name || null,
        createdMovie.images ? JSON.stringify(createdMovie.images) : null,
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
 * TEST ENDPOINT: Test Manual Import API format
 * This endpoint allows testing the Manual Import API with a real movie
 * to verify the exact format required by Radarr
 * 
 * Usage: POST /data-hygiene/test-manual-import/:radarrId
 * No body required - uses the current movie's file
 * 
 * This will attempt to import the existing file to the same movie (safe test)
 */
router.post('/test-manual-import/:radarrId', async (req: Request, res: Response) => {
  try {
    const radarrId = parseInt(req.params.radarrId, 10);
    if (isNaN(radarrId)) {
      return res.status(400).json({ success: false, error: 'Invalid Radarr ID' });
    }

    const radarrClient = new RadarrClient();
    
    // Get current movie
    const currentMovie = await radarrClient.getMovie(radarrId);
    if (!currentMovie || !currentMovie.hasFile || !currentMovie.movieFile) {
      return res.status(400).json({ 
        success: false, 
        error: 'Movie not found or has no files' 
      });
    }

    // Extract file info
    const movieFile = currentMovie.movieFile;
    const fullFilePath = `${currentMovie.path}/${movieFile.relativePath}`;
    
    // Get language
    const storedMovie = db.prepare('SELECT original_language FROM radarr_movies WHERE radarr_id = ?').get(radarrId) as { original_language: string | null } | undefined;
    const languageName = storedMovie?.original_language || currentMovie.originalLanguage?.name || null;
    const languages = convertLanguageToRadarrFormat(languageName);

    // Prepare Manual Import payload (exact format we'll send)
    const manualImportPayload = {
      name: 'ManualImport',
      movieId: radarrId, // Use current movie ID for testing (safe - file is already linked)
      files: [{
        path: fullFilePath,
        quality: movieFile.quality || undefined,
        languages: languages.length > 0 ? languages : undefined,
      }],
      folder: currentMovie.path,
      importMode: 'Auto' as const,
    };

    // Log the payload we're about to send
    console.log('=== MANUAL IMPORT TEST PAYLOAD ===');
    console.log(JSON.stringify(manualImportPayload, null, 2));
    console.log('==================================');

    // Try the API call
    try {
      const result = await radarrClient.manualImport({
        movieId: radarrId,
        files: [{
          path: fullFilePath,
          quality: movieFile.quality,
          languages: languages,
        }],
        folder: currentMovie.path,
        importMode: 'Auto',
      });

      return res.json({
        success: true,
        message: 'Manual Import API call succeeded! Check Radarr to verify file linking.',
        payload: manualImportPayload,
        response: result,
        note: 'This was a test with the existing movie - the file should remain linked',
      });
    } catch (apiError: any) {
      // Return the error details so we can see what went wrong
      const errorResponse = apiError.response?.data || {};
      return res.status(500).json({
        success: false,
        error: apiError.message,
        errorDetails: {
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          data: errorResponse,
          message: errorResponse.message || apiError.message,
        },
        payload: manualImportPayload,
        note: 'Check the error details above to understand what format Radarr expects. The payload shows what we sent.',
      });
    }
  } catch (error: any) {
    console.error('Test Manual Import error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to test Manual Import',
      stack: error?.stack,
    });
  }
});

export default router;

