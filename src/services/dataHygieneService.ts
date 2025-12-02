import db from '../db';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { getLanguageCode, getLanguageName, isIndianLanguage, MAJOR_INDIAN_LANGUAGES } from '../utils/languageMapping';
import path from 'path';

export interface DataHygieneMovie {
  radarr_id: number;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  year: number | null;
  path: string | null;
  movie_file: string | null;
  original_language: string | null;
  tmdb_original_language?: string | null;
  tmdb_title?: string | null;
  folder_name?: string;
  file_name?: string;
  expected_folder_name?: string;
  expected_file_name?: string;
  radarr_language_code?: string;
  tmdb_language_code?: string;
  language_mismatch?: boolean;
}

/**
 * Get movies with missing IMDB IDs
 */
export function getMissingImdbMovies(): DataHygieneMovie[] {
  const rows = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE imdb_id IS NULL OR imdb_id = ''
      ORDER BY title
    `)
    .all() as any[];

  return rows.map(row => ({
    radarr_id: row.radarr_id,
    tmdb_id: row.tmdb_id,
    imdb_id: row.imdb_id,
    title: row.title,
    year: row.year,
    path: row.path,
    movie_file: row.movie_file,
    original_language: row.original_language,
  }));
}

/**
 * Get non-Indian movies (where TMDB original language is not in approved list)
 */
export async function getNonIndianMovies(): Promise<DataHygieneMovie[]> {
  const allMovies = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE tmdb_id IS NOT NULL
      ORDER BY title
    `)
    .all() as any[];

  const nonIndianMovies: DataHygieneMovie[] = [];
  const tmdbClient = new TMDBClient();
  
  // Get TMDB API key
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }

  for (const movie of allMovies) {
    if (!movie.tmdb_id) continue;

    let tmdbLanguage: string | null = null;
    let tmdbTitle: string | null = null;

    try {
      const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);
      if (tmdbMovie) {
        tmdbLanguage = tmdbMovie.original_language || null;
        tmdbTitle = tmdbMovie.title || null;
      }
    } catch (error) {
      console.warn(`Failed to fetch TMDB data for movie ${movie.tmdb_id}:`, error);
    }

    const languageCode = getLanguageCode(tmdbLanguage || movie.original_language);
    const isIndian = languageCode ? MAJOR_INDIAN_LANGUAGES.has(languageCode) : false;

    if (!isIndian) {
      nonIndianMovies.push({
        radarr_id: movie.radarr_id,
        tmdb_id: movie.tmdb_id,
        imdb_id: movie.imdb_id,
        title: movie.title,
        year: movie.year,
        path: movie.path,
        movie_file: movie.movie_file,
        original_language: movie.original_language,
        tmdb_original_language: tmdbLanguage,
        tmdb_title: tmdbTitle,
      });
    }
  }

  return nonIndianMovies;
}

/**
 * Get all file names from Radarr movies
 */
export function getFileNames(): DataHygieneMovie[] {
  const rows = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE has_file = 1 AND movie_file IS NOT NULL
      ORDER BY title
    `)
    .all() as any[];

  return rows.map(row => {
    let fileName: string | undefined;
    try {
      const movieFile = JSON.parse(row.movie_file);
      if (movieFile && movieFile.relativePath) {
        fileName = movieFile.relativePath;
      }
    } catch (error) {
      // Invalid JSON, skip
    }

    return {
      radarr_id: row.radarr_id,
      tmdb_id: row.tmdb_id,
      imdb_id: row.imdb_id,
      title: row.title,
      year: row.year,
      path: row.path,
      movie_file: row.movie_file,
      original_language: row.original_language,
      file_name: fileName,
    };
  });
}

/**
 * Get movies where folder name doesn't match TMDB title and year
 */
export async function getFolderNameMismatches(): Promise<DataHygieneMovie[]> {
  const rows = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE path IS NOT NULL AND tmdb_id IS NOT NULL
      ORDER BY title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];
  const tmdbClient = new TMDBClient();
  
  // Get TMDB API key
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }

  for (const movie of rows) {
    if (!movie.path || !movie.tmdb_id) continue;

    // Extract folder name from path
    const folderName = path.basename(movie.path);

    // Get TMDB data
    let tmdbTitle: string | null = null;
    let tmdbYear: number | null = null;

    try {
      const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);
      if (tmdbMovie) {
        tmdbTitle = tmdbMovie.title || null;
        tmdbYear = tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : null;
      }
    } catch (error) {
      console.warn(`Failed to fetch TMDB data for movie ${movie.tmdb_id}:`, error);
    }

    if (!tmdbTitle) continue;

    // Expected folder name format: "Movie Title (Year)"
    const expectedFolderName = tmdbYear 
      ? `${normalizeForComparison(tmdbTitle)} (${tmdbYear})`
      : normalizeForComparison(tmdbTitle);

    const actualFolderName = normalizeForComparison(folderName);

    // Exact match comparison
    if (actualFolderName !== expectedFolderName) {
      mismatches.push({
        radarr_id: movie.radarr_id,
        tmdb_id: movie.tmdb_id,
        imdb_id: movie.imdb_id,
        title: movie.title,
        year: movie.year,
        path: movie.path,
        movie_file: movie.movie_file,
        original_language: movie.original_language,
        folder_name: folderName,
        expected_folder_name: tmdbYear ? `${tmdbTitle} (${tmdbYear})` : tmdbTitle,
        tmdb_title: tmdbTitle,
      });
    }
  }

  return mismatches;
}

/**
 * Get movies where file name doesn't match TMDB title and year
 */
export async function getFileNameMismatches(): Promise<DataHygieneMovie[]> {
  const rows = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE has_file = 1 AND movie_file IS NOT NULL AND tmdb_id IS NOT NULL
      ORDER BY title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];
  const tmdbClient = new TMDBClient();
  
  // Get TMDB API key
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }

  for (const movie of rows) {
    if (!movie.movie_file || !movie.tmdb_id) continue;

    // Extract file name from movie_file JSON
    let fileName: string | undefined;
    try {
      const movieFile = JSON.parse(movie.movie_file);
      if (movieFile && movieFile.relativePath) {
        fileName = path.basename(movieFile.relativePath);
      }
    } catch (error) {
      continue; // Invalid JSON, skip
    }

    if (!fileName) continue;

    // Get TMDB data
    let tmdbTitle: string | null = null;
    let tmdbYear: number | null = null;

    try {
      const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);
      if (tmdbMovie) {
        tmdbTitle = tmdbMovie.title || null;
        tmdbYear = tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : null;
      }
    } catch (error) {
      console.warn(`Failed to fetch TMDB data for movie ${movie.tmdb_id}:`, error);
    }

    if (!tmdbTitle) continue;

    // Expected file name should contain TMDB title and year
    const normalizedTmdbTitle = normalizeForComparison(tmdbTitle);
    const normalizedFileName = normalizeForComparison(fileName);

    // Check if file name contains TMDB title and year
    const hasTitle = normalizedFileName.includes(normalizedTmdbTitle);
    const hasYear = tmdbYear ? normalizedFileName.includes(tmdbYear.toString()) : true;

    if (!hasTitle || !hasYear) {
      mismatches.push({
        radarr_id: movie.radarr_id,
        tmdb_id: movie.tmdb_id,
        imdb_id: movie.imdb_id,
        title: movie.title,
        year: movie.year,
        path: movie.path,
        movie_file: movie.movie_file,
        original_language: movie.original_language,
        file_name: fileName,
        expected_file_name: tmdbYear ? `${tmdbTitle} (${tmdbYear})` : tmdbTitle,
        tmdb_title: tmdbTitle,
      });
    }
  }

  return mismatches;
}

/**
 * Get movies where Radarr language doesn't match TMDB language
 */
export async function getLanguageMismatches(): Promise<DataHygieneMovie[]> {
  const rows = db
    .prepare(`
      SELECT 
        radarr_id,
        tmdb_id,
        imdb_id,
        title,
        year,
        path,
        movie_file,
        original_language
      FROM radarr_movies
      WHERE tmdb_id IS NOT NULL
      ORDER BY title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];
  const tmdbClient = new TMDBClient();
  
  // Get TMDB API key
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }

  for (const movie of rows) {
    if (!movie.tmdb_id) continue;

    // Get TMDB language
    let tmdbLanguage: string | null = null;
    try {
      const tmdbMovie = await tmdbClient.getMovie(movie.tmdb_id);
      if (tmdbMovie) {
        tmdbLanguage = tmdbMovie.original_language || null;
      }
    } catch (error) {
      console.warn(`Failed to fetch TMDB data for movie ${movie.tmdb_id}:`, error);
      continue;
    }

    if (!tmdbLanguage) continue;

    // Get language codes for comparison
    const radarrLangCode = getLanguageCode(movie.original_language);
    const tmdbLangCode = getLanguageCode(tmdbLanguage);

    // Check if they match (exact comparison)
    if (radarrLangCode !== tmdbLangCode) {
      mismatches.push({
        radarr_id: movie.radarr_id,
        tmdb_id: movie.tmdb_id,
        imdb_id: movie.imdb_id,
        title: movie.title,
        year: movie.year,
        path: movie.path,
        movie_file: movie.movie_file,
        original_language: movie.original_language,
        tmdb_original_language: tmdbLanguage,
        radarr_language_code: radarrLangCode,
        tmdb_language_code: tmdbLangCode,
        language_mismatch: true,
      });
    }
  }

  return mismatches;
}

/**
 * Normalize string for comparison (remove special chars, lowercase, trim)
 */
function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

