import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { feedsModel } from '../models/feeds';
import radarrClient from '../radarr/client';
import tmdbClient from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { config } from '../config';
import { Release } from '../types/Release';

const router = Router();

function sanitizeTitle(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a clean movie name + year from a normalized title by removing quality information.
 * This is used for matching releases that represent the same movie but with different quality.
 * 
 * Example:
 *   "nishaanchi 2 2025 1080p amzn web dl dd 5 1 atmos h 264 khn" 
 *   -> "nishaanchi 2 2025"
 */
function extractMovieNameAndYear(normalizedTitle: string, year?: number): string {
  // Start with the normalized title
  let clean = normalizedTitle.toLowerCase();
  
  // Remove year if it's embedded (we'll add it back at the end)
  clean = clean.replace(/\b(19|20)\d{2}\b/g, '');
  
  // Remove common quality/resolution patterns (with or without spaces)
  clean = clean.replace(/\b(2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd)\b/gi, '');
  
  // Remove codec patterns (handle spaces: "h 264", "h 265", "h264", "h.264", etc.)
  clean = clean.replace(/\b(x264|x265|h\s*\.?\s*264|h\s*\.?\s*265|h264|h265|hevc|avc)\b/gi, '');
  
  // Remove source tags (handle spaces: "web dl", "webdl", etc.)
  clean = clean.replace(/\b(amzn|netflix|nf|jc|jiocinema|zee5|dsnp|disney|hotstar|hs|ss|web\s*dl|webdl|webrip|bluray|dvdrip)\b/gi, '');
  
  // Remove audio patterns (handle spaces: "5 1", "5.1", "dd +", etc.)
  clean = clean.replace(/\b(dd\s*\+?\s*|ddp|eac3|ac3|atmos|truehd|dts|aac|stereo|5\s*\.?\s*1|7\s*\.?\s*1|2\s*\.?\s*0)\b/gi, '');
  
  // Remove common release group patterns (usually at the end: "dtr", "khn", "DTR-KHN", etc.)
  // Match 2-4 letter groups, optionally with dashes/underscores
  clean = clean.replace(/\b([a-z]{2,4}(?:[-_][a-z]{2,4})?)\b/gi, '');
  
  // Remove any remaining large numbers that are likely quality-related (like "264", "265", etc.)
  // But keep single digits that might be part of movie titles (like "Nishaanchi 2")
  clean = clean.replace(/\b\d{3,}\b/g, '');
  
  // Remove extra whitespace and trim
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // Add year back if provided
  if (year) {
    clean = `${clean} ${year}`;
  }
  
  return clean.trim();
}

function buildDisplayTitle(release: Release): string {
  if (release.radarr_movie_title) {
    return release.radarr_movie_title;
  }
  if (release.tmdb_title) {
    return release.tmdb_title;
  }
  const base = sanitizeTitle(release.title || '');
  if (release.year && !base.includes(release.year.toString())) {
    return `${base} (${release.year})`.trim();
  }
  return base || release.title || 'Unknown Title';
}

router.get('/', async (req: Request, res: Response) => {
  try {
    // Get TMDB API key from settings
    const settings = settingsModel.getAll();
    const tmdbApiKey = settings.find(s => s.key === 'tmdb_api_key')?.value;
    if (tmdbApiKey) {
      tmdbClient.setApiKey(tmdbApiKey);
    }

    // Get all releases
    const allReleases = releasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Get feed names for display
    const feedMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
      }
    }

    // Add feed names to releases
    for (const release of allReleases) {
      (release as any).feedName = feedMap[release.feed_id] || 'Unknown Feed';
    }

    // Group releases by movie (using TMDB ID as primary key, fallback to normalized title)
    // Two-pass approach: first group by ID, then merge title-based groups that match ID-based groups
    const releasesByMovie: { [key: string]: any[] } = {};
    const idToKeyMap: { [key: string]: string } = {}; // Map TMDB/Radarr IDs to their movieKey
    
    // First pass: Group releases that have TMDB or Radarr IDs
    for (const release of allReleases) {
      if (release.tmdb_id || release.radarr_movie_id) {
        let movieKey: string;
        if (release.tmdb_id) {
          movieKey = `tmdb_${release.tmdb_id}`;
          idToKeyMap[`tmdb_${release.tmdb_id}`] = movieKey;
        } else {
          movieKey = `radarr_${release.radarr_movie_id}`;
          idToKeyMap[`radarr_${release.radarr_movie_id}`] = movieKey;
        }
        
        if (!releasesByMovie[movieKey]) {
          releasesByMovie[movieKey] = [];
        }
        releasesByMovie[movieKey].push(release);
      }
    }
    
    // Second pass: For releases without IDs, try to match them to existing groups
    // by extracting clean movie name + year (without quality info) and matching
    for (const release of allReleases) {
      if (!release.tmdb_id && !release.radarr_movie_id) {
        const releaseMovieKey = extractMovieNameAndYear(release.normalized_title, release.year);
        const titleKey = `title_${releaseMovieKey}`;
        
        // Try to find a matching group by checking if any release in an existing group
        // has the same clean movie name + year (ignoring quality differences)
        let matched = false;
        for (const existingKey in releasesByMovie) {
          const existingReleases = releasesByMovie[existingKey];
          // Check if any release in this group has the same clean movie name + year
          const hasMatch = existingReleases.some(r => {
            const existingMovieKey = extractMovieNameAndYear(r.normalized_title, r.year);
            return existingMovieKey === releaseMovieKey;
          });
          
          if (hasMatch) {
            releasesByMovie[existingKey].push(release);
            matched = true;
            break;
          }
        }
        
        // If no match found, create a new group
        if (!matched) {
          if (!releasesByMovie[titleKey]) {
            releasesByMovie[titleKey] = [];
          }
          releasesByMovie[titleKey].push(release);
        }
      }
    }

    // Build movie groups with metadata
    const movieGroups: Array<{
      movieKey: string;
      movieTitle: string;
      tmdbId?: number;
      radarrMovieId?: number;
      posterUrl?: string;
      imdbId?: string;
      originalLanguage?: string;
      add: any[];
      existing: any[];
      upgrade: any[];
    }> = [];

    for (const movieKey in releasesByMovie) {
      const releases = releasesByMovie[movieKey];
      
      // Get the primary movie info (prefer from existing/upgrade releases as they have more metadata)
      const primaryRelease = releases.find(r => r.radarr_movie_id) || 
                            releases.find(r => r.tmdb_id) || 
                            releases[0];
      
      const movieTitle = buildDisplayTitle(primaryRelease);

      const hasRadarrMatch = releases.some(r => Boolean(r.radarr_movie_id));
      
      // Categorize releases by state
      const upgrade = releases.filter(r => (
        r.radarr_movie_id &&
        (r.status === 'UPGRADE_CANDIDATE' || r.status === 'UPGRADED')
      ));
      const upgradeGuids = new Set(upgrade.map(r => r.guid));

      const add = hasRadarrMatch
        ? []
        : releases.filter(r => !r.radarr_movie_id);

      const existing = releases.filter(r => (
        !upgradeGuids.has(r.guid) &&
        (r.radarr_movie_id || hasRadarrMatch)
      ));
      
      // Extract Radarr info from the first release that has existing_file_attributes
      let radarrInfo: any = null;
      const releaseWithRadarrInfo = releases.find(r => r.existing_file_attributes);
      if (releaseWithRadarrInfo && releaseWithRadarrInfo.existing_file_attributes) {
        try {
          radarrInfo = JSON.parse(releaseWithRadarrInfo.existing_file_attributes);
        } catch (e) {
          console.error('Error parsing existing_file_attributes:', e);
        }
      }
      
      movieGroups.push({
        movieKey,
        movieTitle,
        tmdbId: primaryRelease.tmdb_id,
        radarrMovieId: primaryRelease.radarr_movie_id,
        radarrInfo, // Add Radarr info to the movie group
        add,
        existing,
        upgrade,
      });
    }

    // Enrich with movie metadata (poster, IMDB, etc.)
    for (const movieGroup of movieGroups) {
      // Get movie metadata if we have TMDB ID or Radarr movie ID
      if (movieGroup.tmdbId || movieGroup.radarrMovieId) {
        try {
          let movie: any = null;
          if (movieGroup.radarrMovieId) {
            movie = await radarrClient.getMovie(movieGroup.radarrMovieId);
          } else if (movieGroup.tmdbId) {
            movie = await radarrClient.getMovie(movieGroup.tmdbId);
          }
          
          if (movie) {
            // Get poster URL (Radarr provides images array)
            if (movie.images && movie.images.length > 0) {
              const poster = movie.images.find((img: any) => img.coverType === 'poster');
              if (poster) {
                movieGroup.posterUrl = poster.remoteUrl || poster.url;
              }
            }
            
            // Get IMDB ID
            if (movie.imdbId) {
              movieGroup.imdbId = movie.imdbId;
            }
            
            // Get TMDB ID (already have it, but ensure it's set)
            if (movie.tmdbId) {
              movieGroup.tmdbId = movie.tmdbId;
            }
            
            // Get original language
            if (movie.originalLanguage) {
              movieGroup.originalLanguage = movie.originalLanguage.name || movie.originalLanguage;
            }
          }
        } catch (error) {
          // Silently fail - just don't add metadata
          console.error(`Error fetching movie metadata for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      // If we still don't have TMDB ID or poster, try TMDB API search
      if ((!movieGroup.tmdbId || !movieGroup.posterUrl) && tmdbApiKey) {
        try {
          // Get a release to extract title and year for search
          const searchRelease = movieGroup.add[0] || movieGroup.existing[0] || movieGroup.upgrade[0];
          if (searchRelease) {
            const searchTitle = searchRelease.tmdb_title || 
                              searchRelease.radarr_movie_title || 
                              searchRelease.title.split(/\s+\d{4}/)[0];
            const searchYear = searchRelease.year;
            
            const tmdbMovie = await tmdbClient.searchMovie(searchTitle, searchYear);
            if (tmdbMovie) {
              if (!movieGroup.tmdbId) {
                movieGroup.tmdbId = tmdbMovie.id;
              }
              if (!movieGroup.posterUrl && tmdbMovie.poster_path) {
                const posterUrl = tmdbClient.getPosterUrl(tmdbMovie.poster_path);
                movieGroup.posterUrl = posterUrl ?? undefined;
              }
              if (!movieGroup.imdbId && tmdbMovie.imdb_id) {
                movieGroup.imdbId = tmdbMovie.imdb_id;
              }
              if (!movieGroup.originalLanguage && tmdbMovie.original_language) {
                movieGroup.originalLanguage = tmdbMovie.original_language;
              }
            }
          }
        } catch (error) {
          console.error(`Error searching TMDB for ${movieGroup.movieTitle}:`, error);
        }
      }
      
      // Add poster/metadata to all releases in this group
      const hasRadarrMatch = movieGroup.existing.some(r => r.radarr_movie_id) || movieGroup.upgrade.some(r => r.radarr_movie_id);

      for (const release of [...movieGroup.add, ...movieGroup.existing, ...movieGroup.upgrade]) {
        if (movieGroup.posterUrl) {
          (release as any).posterUrl = movieGroup.posterUrl;
        }
        if (movieGroup.imdbId) {
          (release as any).imdbId = movieGroup.imdbId;
        }
        if (movieGroup.tmdbId) {
          (release as any).tmdbId = movieGroup.tmdbId;
        }
        if (movieGroup.originalLanguage) {
          (release as any).originalLanguage = movieGroup.originalLanguage;
        }
        if (!release.radarr_movie_id && hasRadarrMatch) {
          (release as any).radarrInferred = true;
        }
      }
    }

    // Sort movie groups by latest release date (most recent first)
    movieGroups.sort((a, b) => {
      // Get the most recent published_at date from all releases in each group
      const getLatestDate = (group: typeof a) => {
        const allReleases = [...group.add, ...group.existing, ...group.upgrade];
        if (allReleases.length === 0) return 0;
        const dates = allReleases.map(r => new Date(r.published_at).getTime());
        return Math.max(...dates);
      };
      
      const dateA = getLatestDate(a);
      const dateB = getLatestDate(b);
      return dateB - dateA; // Descending order (newest first)
    });

    // Get Radarr base URL for links
    const radarrBaseUrl = config.radarr.apiUrl.replace('/api/v3', '');

    res.render('dashboard', {
      movieGroups,
      radarrBaseUrl,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

export default router;

