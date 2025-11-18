import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { feedsModel } from '../models/feeds';
import radarrClient from '../radarr/client';
import tmdbClient from '../tmdb/client';
import { settingsModel } from '../models/settings';
import { config } from '../config';

const router = Router();

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
      
      const movieTitle = primaryRelease.radarr_movie_title || 
                        primaryRelease.tmdb_title || 
                        primaryRelease.title.split(/\s+\d{4}/)[0]; // Extract title without year
      
      // Categorize releases by status
      const add = releases.filter(r => r.status === 'NEW');
      const existing = releases.filter(r => r.status === 'IGNORED' && r.radarr_movie_id);
      const upgrade = releases.filter(r => r.status === 'UPGRADE_CANDIDATE');
      
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
                movieGroup.posterUrl = tmdbClient.getPosterUrl(tmdbMovie.poster_path);
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

