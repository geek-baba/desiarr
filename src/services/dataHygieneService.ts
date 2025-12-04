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
  has_file?: number; // 0 or 1
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
  // JOIN with TMDB cache to get TMDB title and release_date (for year)
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
        t.release_date as tmdb_release_date
      FROM radarr_movies r
      INNER JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.path IS NOT NULL AND r.tmdb_id IS NOT NULL AND t.title IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];

  for (const movie of rows) {
    if (!movie.path || !movie.tmdb_id || !movie.tmdb_title) continue;

    // Extract actual folder name from Radarr path
    const actualFolderName = path.basename(movie.path);

    // Use TMDB as source of truth
    const tmdbTitle = movie.tmdb_title;
    // Extract year from TMDB release_date, fallback to Radarr year
    const tmdbYear = extractYearFromReleaseDate(movie.tmdb_release_date) || movie.year;

    // Apply Radarr's CleanTitle logic to TMDB title
    const cleanTitle = getRadarrCleanTitle(tmdbTitle);

    // Generate expected folder name: "{Movie CleanTitle} ({Release Year})"
    const expectedFolderName = tmdbYear 
      ? `${cleanTitle} (${tmdbYear})`
      : cleanTitle;

    // Exact match comparison (case-sensitive, as Radarr uses exact format)
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
        folder_name: actualFolderName,
        expected_folder_name: expectedFolderName,
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
  // JOIN with TMDB cache to get TMDB title, release_date (for year), and IMDB ID
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
        t.release_date as tmdb_release_date,
        t.imdb_id as tmdb_imdb_id
      FROM radarr_movies r
      INNER JOIN tmdb_movie_cache t ON r.tmdb_id = t.tmdb_id AND t.is_deleted = 0
      WHERE r.has_file = 1 AND r.movie_file IS NOT NULL AND r.tmdb_id IS NOT NULL AND t.title IS NOT NULL
      ORDER BY r.title
    `)
    .all() as any[];

  const mismatches: DataHygieneMovie[] = [];

  for (const movie of rows) {
    if (!movie.movie_file || !movie.tmdb_id || !movie.tmdb_title) continue;

    // Extract actual file name and quality from movie_file JSON
    let fileName: string | undefined;
    let fileExtension: string | undefined;
    let qualityTitle: string | undefined;
    try {
      const movieFile = JSON.parse(movie.movie_file);
      if (movieFile && movieFile.relativePath) {
        fileName = path.basename(movieFile.relativePath);
        // Extract file extension
        const extMatch = fileName.match(/\.([^.]+)$/);
        fileExtension = extMatch ? extMatch[1] : undefined;
      }
      // Extract quality information from Radarr
      if (movieFile && movieFile.quality && movieFile.quality.quality) {
        const quality = movieFile.quality.quality;
        // Format: "Source-Resolution" (e.g., "Bluray-1080p", "WEB-DL-720p")
        const source = quality.source || '';
        const resolution = quality.resolution || '';
        if (source && resolution) {
          qualityTitle = `${source}-${resolution}`;
        } else if (source) {
          qualityTitle = source;
        } else if (resolution) {
          qualityTitle = resolution;
        }
      }
    } catch (error) {
      continue; // Invalid JSON, skip
    }

    if (!fileName) continue;

    // Use TMDB as source of truth
    const tmdbTitle = movie.tmdb_title;
    // Extract year from TMDB release_date, fallback to Radarr year
    const tmdbYear = extractYearFromReleaseDate(movie.tmdb_release_date) || movie.year;
    // Use TMDB IMDB ID, fallback to Radarr IMDB ID
    const tmdbImdbId = movie.tmdb_imdb_id || movie.imdb_id;

    // Apply Radarr's CleanTitle logic to TMDB title
    const cleanTitle = getRadarrCleanTitle(tmdbTitle);

    // Build expected file name: "{Movie CleanTitle} ({Release Year}) {Quality Title} - {imdb-{ImdbId}}.ext"
    // Example: "The Movie Title (2010) Bluray-1080p - {imdb-tt0066921}.mkv"
    const titleYearPart = tmdbYear 
      ? `${cleanTitle} (${tmdbYear})`
      : cleanTitle;
    
    const qualityPart = qualityTitle ? ` ${qualityTitle}` : '';
    const imdbPart = tmdbImdbId ? ` - {imdb-${tmdbImdbId}}` : '';
    const extPart = fileExtension ? `.${fileExtension}` : '';
    
    const expectedFileName = `${titleYearPart}${qualityPart}${imdbPart}${extPart}`;

    // Check if file name matches expected format
    // We'll do a more flexible check: verify it starts with title+year and ends with imdb+ext (if present)
    const fileNameLower = fileName.toLowerCase();
    const expectedStart = titleYearPart.toLowerCase();
    
    // Check if file starts with expected title+year
    const startsCorrectly = fileNameLower.startsWith(expectedStart);
    
    // Check if file ends with IMDB ID + extension (if TMDB IMDB ID is present)
    let endsCorrectly = true;
    if (tmdbImdbId) {
      const expectedImdbSuffix = fileExtension 
        ? `{imdb-${tmdbImdbId.toLowerCase()}}.${fileExtension.toLowerCase()}`
        : `{imdb-${tmdbImdbId.toLowerCase()}}`;
      endsCorrectly = fileNameLower.endsWith(expectedImdbSuffix.toLowerCase());
    } else if (fileExtension) {
      // If no IMDB ID, check if it ends with the extension
      endsCorrectly = fileNameLower.endsWith(`.${fileExtension.toLowerCase()}`);
    }
    
    // If quality is specified, check if it's present in the filename
    let hasQuality = true;
    if (qualityTitle) {
      hasQuality = fileNameLower.includes(qualityTitle.toLowerCase());
    }

    // If any part doesn't match, it's a mismatch
    if (!startsCorrectly || !endsCorrectly || !hasQuality) {
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
        expected_file_name: expectedFileName,
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
        r.has_file,
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
    has_file: movie.has_file || 0,
    original_language: movie.original_language,
  }));
}

export interface PreservedHistoryEntry {
  id: number;
  radarr_id: number;
  tmdb_id: number | null;
  title: string | null;
  preserved_at: string;
  restored_to_radarr_id: number | null;
  restored_at: string | null;
  history_count: number;
}

/**
 * Get all preserved movie history entries
 */
export function getPreservedHistory(): PreservedHistoryEntry[] {
  const rows = db
    .prepare(`
      SELECT 
        id,
        radarr_id,
        tmdb_id,
        title,
        preserved_at,
        restored_to_radarr_id,
        restored_at,
        (SELECT COUNT(*) FROM json_each(history_data)) as history_count
      FROM radarr_movie_history
      ORDER BY preserved_at DESC
    `)
    .all() as any[];

  // Parse history_data to get actual count
  return rows.map(row => {
    let historyCount = 0;
    try {
      const historyData = db
        .prepare('SELECT history_data FROM radarr_movie_history WHERE id = ?')
        .get(row.id) as { history_data: string } | undefined;
      if (historyData) {
        const parsed = JSON.parse(historyData.history_data);
        historyCount = Array.isArray(parsed) ? parsed.length : 0;
      }
    } catch (e) {
      // Ignore parse errors
    }

    return {
      id: row.id,
      radarr_id: row.radarr_id,
      tmdb_id: row.tmdb_id,
      title: row.title,
      preserved_at: row.preserved_at,
      restored_to_radarr_id: row.restored_to_radarr_id,
      restored_at: row.restored_at,
      history_count: historyCount,
    };
  });
}

/**
 * Generate Radarr's "CleanTitle" format
 * Radarr sanitizes titles by removing/replacing certain characters:
 * - Removes: colons (:), slashes (/), backslashes (\), question marks (?), asterisks (*), pipes (|), quotes ("), less/greater than (< >)
 * - Replaces: periods (.) with spaces
 * - Preserves: spaces, hyphens, apostrophes, parentheses, brackets, numbers, letters
 * 
 * This matches Radarr's CleanTitle logic used for folder/file naming
 */
function getRadarrCleanTitle(title: string): string {
  return title
    .replace(/:/g, '')      // Remove colons
    .replace(/\//g, '')      // Remove forward slashes
    .replace(/\\/g, '')      // Remove backslashes
    .replace(/\?/g, '')      // Remove question marks
    .replace(/\*/g, '')      // Remove asterisks
    .replace(/\|/g, '')       // Remove pipes
    .replace(/"/g, '')       // Remove double quotes
    .replace(/</g, '')        // Remove less than
    .replace(/>/g, '')        // Remove greater than
    .replace(/\./g, ' ')     // Replace periods with spaces
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .trim();
}

/**
 * Extract year from TMDB release_date (format: YYYY-MM-DD or YYYY)
 */
function extractYearFromReleaseDate(releaseDate: string | null): number | null {
  if (!releaseDate) return null;
  const yearMatch = releaseDate.match(/^(\d{4})/);
  return yearMatch ? parseInt(yearMatch[1], 10) : null;
}

/**
 * Normalize string for comparison (remove special chars, lowercase, trim)
 * Used for fuzzy matching, not for exact Radarr format validation
 */
function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

