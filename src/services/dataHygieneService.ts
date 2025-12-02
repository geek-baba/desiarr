import db from '../db';
import { TMDBClient } from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { getLanguageCode, getLanguageName, isIndianLanguage, MAJOR_INDIAN_LANGUAGES } from '../utils/languageMapping';
import path from 'path';

/**
 * Get TMDB data for a movie, using cache first, then API if needed
 */
async function getTmdbData(tmdbId: number, tmdbClient: TMDBClient): Promise<{ title: string | null; original_language: string | null; release_date: string | null } | null> {
  // First, try to get from cached movie_releases
  const cached = db
    .prepare(`
      SELECT tmdb_title, tmdb_original_language
      FROM movie_releases
      WHERE tmdb_id = ?
      LIMIT 1
    `)
    .get(tmdbId) as { tmdb_title: string | null; tmdb_original_language: string | null } | undefined;

  if (cached && cached.tmdb_title) {
    // Get release_date from API if we need it (for year)
    try {
      const tmdbMovie = await tmdbClient.getMovie(tmdbId);
      return {
        title: cached.tmdb_title,
        original_language: cached.tmdb_original_language,
        release_date: tmdbMovie?.release_date || null,
      };
    } catch (error) {
      // If API fails, return cached data without year
      return {
        title: cached.tmdb_title,
        original_language: cached.tmdb_original_language,
        release_date: null,
      };
    }
  }

  // Not in cache, fetch from API
  try {
    const tmdbMovie = await tmdbClient.getMovie(tmdbId);
    if (tmdbMovie) {
      return {
        title: tmdbMovie.title || null,
        original_language: tmdbMovie.original_language || null,
        release_date: tmdbMovie.release_date || null,
      };
    }
  } catch (error) {
    console.warn(`Failed to fetch TMDB data for movie ${tmdbId}:`, error);
  }

  return null;
}

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

    const tmdbData = await getTmdbData(movie.tmdb_id, tmdbClient);
    const tmdbLanguage = tmdbData?.original_language || null;
    const tmdbTitle = tmdbData?.title || null;

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

    // Get TMDB data (cached or API)
    const tmdbData = await getTmdbData(movie.tmdb_id, tmdbClient);
    const tmdbTitle = tmdbData?.title || null;
    const tmdbYear = tmdbData?.release_date ? new Date(tmdbData.release_date).getFullYear() : null;

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

    // Get TMDB data (cached or API)
    const tmdbData = await getTmdbData(movie.tmdb_id, tmdbClient);
    const tmdbTitle = tmdbData?.title || null;
    const tmdbYear = tmdbData?.release_date ? new Date(tmdbData.release_date).getFullYear() : null;

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

    // Get TMDB language (cached or API)
    const tmdbData = await getTmdbData(movie.tmdb_id, tmdbClient);
    const tmdbLanguage = tmdbData?.original_language || null;
    
    if (!tmdbLanguage) {
      continue; // Skip if we can't get TMDB language
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

