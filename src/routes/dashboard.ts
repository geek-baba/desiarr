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
    const releasesByMovie: { [key: string]: any[] } = {};
    
    for (const release of allReleases) {
      // Create a unique key for the movie
      let movieKey: string;
      if (release.tmdb_id) {
        movieKey = `tmdb_${release.tmdb_id}`;
      } else if (release.radarr_movie_id) {
        movieKey = `radarr_${release.radarr_movie_id}`;
      } else {
        // Fallback to normalized title + year
        movieKey = `title_${release.normalized_title}_${release.year || 'unknown'}`;
      }
      
      if (!releasesByMovie[movieKey]) {
        releasesByMovie[movieKey] = [];
      }
      releasesByMovie[movieKey].push(release);
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
      
      movieGroups.push({
        movieKey,
        movieTitle,
        tmdbId: primaryRelease.tmdb_id,
        radarrMovieId: primaryRelease.radarr_movie_id,
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

