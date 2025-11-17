import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import radarrClient from '../radarr/client';

const router = Router();

router.post('/:id/add', async (req: Request, res: Response) => {
  try {
    const release = releasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    if (release.status !== 'NEW') {
      return res.status(400).json({ error: 'Release is not in NEW status' });
    }

    if (!release.tmdb_id) {
      return res.status(400).json({ error: 'TMDB ID not found' });
    }

    // Lookup movie details
    const lookupResults = await radarrClient.lookupMovie(release.title);
    const movie = lookupResults.find((m) => m.tmdbId === release.tmdb_id);

    if (!movie) {
      return res.status(404).json({ error: 'Movie not found in Radarr lookup' });
    }

    // Add to Radarr
    await radarrClient.addMovie(movie);

    // Update release status
    releasesModel.updateStatus(release.id!, 'ADDED');

    res.json({ success: true, message: 'Movie added to Radarr' });
  } catch (error) {
    console.error('Add movie error:', error);
    res.status(500).json({ error: 'Failed to add movie' });
  }
});

router.post('/:id/upgrade', async (req: Request, res: Response) => {
  try {
    const release = releasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    if (release.status !== 'UPGRADE_CANDIDATE') {
      return res.status(400).json({ error: 'Release is not an upgrade candidate' });
    }

    if (!release.radarr_movie_id) {
      return res.status(400).json({ error: 'Radarr movie ID not found' });
    }

    // Trigger search in Radarr
    await radarrClient.triggerSearch(release.radarr_movie_id);

    // Update release status
    releasesModel.updateStatus(release.id!, 'UPGRADED');

    res.json({ success: true, message: 'Upgrade search triggered in Radarr' });
  } catch (error) {
    console.error('Upgrade movie error:', error);
    res.status(500).json({ error: 'Failed to trigger upgrade' });
  }
});

router.post('/:id/ignore', async (req: Request, res: Response) => {
  try {
    const release = releasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    // Update release status
    releasesModel.updateStatus(release.id!, 'IGNORED');

    res.json({ success: true, message: 'Release ignored' });
  } catch (error) {
    console.error('Ignore release error:', error);
    res.status(500).json({ error: 'Failed to ignore release' });
  }
});

export default router;

