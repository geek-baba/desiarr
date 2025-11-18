import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { feedsModel } from '../models/feeds';

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

    // Add feed names to releases for easier access in template
    for (const feed of categorized) {
      for (const release of [...feed.add, ...feed.existing, ...feed.upgrade]) {
        (release as any).feedName = feed.feedName;
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

