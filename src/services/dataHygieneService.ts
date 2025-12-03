import db from '../db';
import { getLanguageCode, MAJOR_INDIAN_LANGUAGES } from '../utils/languageMapping';
import path from 'path';

/**
 * Get TMDB data from cache (movie_releases) for a tmdb_id
 * Returns null if not in cache - no API calls
 */
function getTmdbDataFromCache(tmdbId: number): { title: string | null; original_language: string | null } | null {
  const cached = db
    .prepare(`
      SELECT tmdb_title, tmdb_original_language
      FROM movie_releases
      WHERE tmdb_id = ?
      LIMIT 1
    `)
    .get(tmdbId) as { tmdb_title: string | null; tmdb_original_language: string | null } | undefined;

  if (cached && cached.tmdb_title) {
    return {
      title: cached.tmdb_title,
      original_language: cached.tmdb_original_language,
    };
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
  origin_country?: string | null;
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
 * Uses cached TMDB data from tmdb_movie_cache - no API calls
 */
export function getNonIndianMovies(): DataHygieneMovie[] {
  // Use LEFT JOIN to get TMDB data from tmdb_movie_cache
  const rows = db
    .prepare(`
      SELECT DISTINCT
        r.radarr_id,
        r.tmdb_id,
        r.imdb_id,
        r.title,
        r.year,
        r.path,
        r.movie_file,
        r.original_language,
        t.title as tmdb_title,
        t.original_language as tmdb_original_language,
        t.primary_country as origin_country
      FROM radarr_movies r
      LEFT JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.tmdb_id IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const nonIndianMovies: DataHygieneMovie[] = [];

  for (const movie of rows) {
    if (!movie.tmdb_id) continue;

    // Use cached TMDB data, fallback to Radarr language
    const tmdbLanguage = movie.tmdb_original_language || null;
    const tmdbTitle = movie.tmdb_title || null;

    // Check BOTH languages - only mark as non-Indian if NEITHER is Indian
    const tmdbLangCode = getLanguageCode(tmdbLanguage);
    const radarrLangCode = getLanguageCode(movie.original_language);
    const tmdbIsIndian = tmdbLangCode ? MAJOR_INDIAN_LANGUAGES.has(tmdbLangCode) : false;
    const radarrIsIndian = radarrLangCode ? MAJOR_INDIAN_LANGUAGES.has(radarrLangCode) : false;
    const isIndian = tmdbIsIndian || radarrIsIndian; // If EITHER is Indian, it's Indian

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
        origin_country: movie.origin_country || null,
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
 * Uses cached TMDB data and radarr_movies.year as fallback - no API calls
 */
export function getFolderNameMismatches(): DataHygieneMovie[] {
  // Use LEFT JOIN to get TMDB data from tmdb_movie_cache
  const rows = db
    .prepare(`
      SELECT DISTINCT
        r.radarr_id,
        r.tmdb_id,
        r.imdb_id,
        r.title,
        r.year,
        r.path,
        r.movie_file,
        r.original_language,
        t.title as tmdb_title
      FROM radarr_movies r
      LEFT JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.path IS NOT NULL AND r.tmdb_id IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];

  for (const movie of rows) {
    if (!movie.path || !movie.tmdb_id) continue;

    // Extract folder name from path
    const folderName = path.basename(movie.path);

    // Use cached TMDB title, fallback to Radarr title
    const tmdbTitle = movie.tmdb_title || movie.title;
    // Use Radarr year as fallback (TMDB year would require API call)
    const tmdbYear = movie.year;

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
 * Uses cached TMDB data and radarr_movies.year as fallback - no API calls
 */
export function getFileNameMismatches(): DataHygieneMovie[] {
  // Use LEFT JOIN to get TMDB data from tmdb_movie_cache
  const rows = db
    .prepare(`
      SELECT DISTINCT
        r.radarr_id,
        r.tmdb_id,
        r.imdb_id,
        r.title,
        r.year,
        r.path,
        r.movie_file,
        r.original_language,
        t.title as tmdb_title
      FROM radarr_movies r
      LEFT JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.has_file = 1 AND r.movie_file IS NOT NULL AND r.tmdb_id IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];

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

    // Use cached TMDB title, fallback to Radarr title
    const tmdbTitle = movie.tmdb_title || movie.title;
    // Use Radarr year as fallback (TMDB year would require API call)
    const tmdbYear = movie.year;

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
 * Uses cached TMDB data from tmdb_movie_cache - no API calls
 */
export function getLanguageMismatches(): DataHygieneMovie[] {
  // Use LEFT JOIN to get TMDB data from tmdb_movie_cache
  const rows = db
    .prepare(`
      SELECT DISTINCT
        r.radarr_id,
        r.tmdb_id,
        r.imdb_id,
        r.title,
        r.year,
        r.path,
        r.movie_file,
        r.original_language,
        t.original_language as tmdb_original_language
      FROM radarr_movies r
      LEFT JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.tmdb_id IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];

  for (const movie of rows) {
    if (!movie.tmdb_id) continue;

    // Use cached TMDB language
    const tmdbLanguage = movie.tmdb_original_language || null;
    
    if (!tmdbLanguage) {
      continue; // Skip if we don't have TMDB language in cache
    }

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
 * Get movies marked as deleted in TMDB cache but still in Radarr
 * These are movies that returned 404 from TMDB API but are still in Radarr
 */
export function getDeletedTitles(): DataHygieneMovie[] {
  const rows = db
    .prepare(`
      SELECT DISTINCT
        r.radarr_id,
        r.tmdb_id,
        r.imdb_id,
        r.title,
        r.year,
        r.path,
        r.movie_file,
        r.original_language,
        t.synced_at as deleted_synced_at
      FROM radarr_movies r
      INNER JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id
      WHERE t.is_deleted = 1
      ORDER BY r.title
    `)
    .all() as any[];

  return rows.map(movie => ({
    radarr_id: movie.radarr_id,
    tmdb_id: movie.tmdb_id,
    imdb_id: movie.imdb_id,
    title: movie.title,
    year: movie.year,
    path: movie.path,
    movie_file: movie.movie_file,
    original_language: movie.original_language,
  }));
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

