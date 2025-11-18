import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { feedsModel } from '../models/feeds';
import radarrClient from '../radarr/client';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    // Get all releases, grouped by feed
    const allReleases = releasesModel.getAll();
    const feeds = feedsModel.getAll();
    
    // Group releases by feed_id
    const releasesByFeed: { [key: number]: any[] } = {};
    for (const release of allReleases) {
      if (!releasesByFeed[release.feed_id]) {
        releasesByFeed[release.feed_id] = [];
      }
      releasesByFeed[release.feed_id].push(release);
    }

    // Get feed names for display
    const feedMap: { [key: number]: string } = {};
    for (const feed of feeds) {
      if (feed.id) {
        feedMap[feed.id] = feed.name;
      }
    }

    // Categorize releases by status
    const categorized: {
      feedId: number;
      feedName: string;
      add: any[];
      existing: any[];
      upgrade: any[];
    }[] = [];

    for (const feedId in releasesByFeed) {
      const feedIdNum = parseInt(feedId, 10);
      const releases = releasesByFeed[feedIdNum];
      
      categorized.push({
        feedId: feedIdNum,
        feedName: feedMap[feedIdNum] || 'Unknown Feed',
        add: releases.filter(r => r.status === 'NEW'),
        existing: releases.filter(r => r.status === 'IGNORED' && r.radarr_movie_id),
        upgrade: releases.filter(r => r.status === 'UPGRADE_CANDIDATE'),
      });
    }

    // Add feed names and enrich with movie metadata for easier access in template
    for (const feed of categorized) {
      for (const release of [...feed.add, ...feed.existing, ...feed.upgrade]) {
        (release as any).feedName = feed.feedName;
        
        // Get movie metadata if we have TMDB ID or Radarr movie ID
        if (release.tmdb_id || release.radarr_movie_id) {
          try {
            let movie: any = null;
            if (release.radarr_movie_id) {
              movie = await radarrClient.getMovie(release.radarr_movie_id);
            } else if (release.tmdb_id) {
              movie = await radarrClient.getMovie(release.tmdb_id);
            }
            
            if (movie) {
              // Get poster URL (Radarr provides images array)
              if (movie.images && movie.images.length > 0) {
                const poster = movie.images.find((img: any) => img.coverType === 'poster');
                if (poster) {
                  (release as any).posterUrl = poster.remoteUrl || poster.url;
                }
              }
              
              // Get IMDB ID
              if (movie.imdbId) {
                (release as any).imdbId = movie.imdbId;
              }
              
              // Get TMDB ID (already have it, but ensure it's set)
              if (movie.tmdbId) {
                (release as any).tmdbId = movie.tmdbId;
              }
              
              // Get original language
              if (movie.originalLanguage) {
                (release as any).originalLanguage = movie.originalLanguage.name || movie.originalLanguage;
              }
            }
          } catch (error) {
            // Silently fail - just don't add metadata
            console.error(`Error fetching movie metadata for release ${release.id}:`, error);
          }
        }
      }
    }

    res.render('dashboard', {
      feeds: categorized,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

export default router;

