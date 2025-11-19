import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import radarrClient from '../radarr/client';
import { Release } from '../types/Release';

const router = Router();

router.get('/radarr-options', async (req: Request, res: Response) => {
  try {
    const qualityProfiles = await radarrClient.getQualityProfiles();
    const rootFolders = await radarrClient.getRootFolders();
    
    res.json({
      success: true,
      qualityProfiles,
      rootFolders,
    });
  } catch (error: any) {
    console.error('Get Radarr options error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch Radarr options',
      details: error?.message || undefined,
    });
  }
});

router.post('/:id/add', async (req: Request, res: Response) => {
  try {
    const release = releasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    console.log(`Add movie request for release ID ${req.params.id}: status=${release.status}, tmdb_id=${release.tmdb_id}, radarr_movie_id=${release.radarr_movie_id}`);

    // Also check if movie already exists in Radarr
    if (release.radarr_movie_id) {
      return res.status(400).json({ 
        error: 'Movie already exists in Radarr. Use upgrade instead.' 
      });
    }

    // Allow adding if status is NEW or ATTENTION_NEEDED (both are "new" movies not in Radarr)
    if (release.status !== 'NEW' && release.status !== 'ATTENTION_NEEDED') {
      return res.status(400).json({ 
        error: `Release is not in NEW or ATTENTION_NEEDED status (current status: ${release.status})` 
      });
    }

    // For ATTENTION_NEEDED releases, we might not have a TMDB ID, so allow adding without it
    // The Radarr lookup will try to find it
    if (!release.tmdb_id && release.status !== 'ATTENTION_NEEDED') {
      return res.status(400).json({ error: 'TMDB ID not found' });
    }

    const { qualityProfileId, rootFolderPath } = req.body;

    if (!qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ 
        error: 'Quality profile ID and root folder path are required' 
      });
    }

    // Lookup movie by TMDB ID directly (more reliable than title search)
    let movie = await radarrClient.lookupMovieByTmdbId(release.tmdb_id);
    
    // Fallback to title lookup if TMDB ID lookup fails
    if (!movie) {
      console.log(`TMDB ID lookup failed for ${release.tmdb_id}, trying title lookup...`);
      const lookupResults = await radarrClient.lookupMovie(release.tmdb_title || release.title);
      movie = lookupResults.find((m) => m.tmdbId === release.tmdb_id) || null;
    }

    if (!movie) {
      return res.status(404).json({ 
        error: `Movie not found in Radarr lookup for TMDB ID ${release.tmdb_id}` 
      });
    }

    // Add to Radarr with selected options
    const addedMovie = await radarrClient.addMovie(movie, parseInt(qualityProfileId, 10), rootFolderPath);

    // Update release with Radarr movie ID
    const updatedRelease: Omit<Release, 'id'> = {
      ...release,
      radarr_movie_id: addedMovie.id,
      radarr_movie_title: addedMovie.title,
      status: 'ADDED',
    };
    releasesModel.upsert(updatedRelease);

    res.json({ 
      success: true, 
      message: `Movie "${addedMovie.title}" added to Radarr successfully`,
      radarrMovieId: addedMovie.id,
    });
  } catch (error: any) {
    console.error('Add movie error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    res.status(500).json({ 
      error: `Failed to add movie: ${errorMessage}`,
      details: error?.response?.data || undefined,
    });
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

    res.json({ 
      success: true, 
      message: `Upgrade search triggered for "${release.radarr_movie_title || release.title}"` 
    });
  } catch (error: any) {
    console.error('Upgrade movie error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    res.status(500).json({ 
      error: `Failed to trigger upgrade: ${errorMessage}`,
      details: error?.response?.data || undefined,
    });
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

router.post('/:id/override-tmdb', async (req: Request, res: Response) => {
  try {
    const release = releasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'Release not found' });
    }

    const { tmdbId } = req.body;
    
    if (!tmdbId || isNaN(parseInt(tmdbId, 10))) {
      return res.status(400).json({ error: 'Valid TMDB ID is required' });
    }

    // Import tmdbClient
    const tmdbClient = (await import('../tmdb/client')).default;
    
    // Verify the TMDB ID by fetching movie details
    const tmdbMovie = await tmdbClient.getMovie(parseInt(tmdbId, 10));
    if (!tmdbMovie) {
      return res.status(404).json({ error: 'TMDB ID not found' });
    }

    // Update the release with the new TMDB ID
    const updatedRelease: Omit<Release, 'id'> = {
      ...release,
      tmdb_id: parseInt(tmdbId, 10),
      tmdb_title: tmdbMovie.title,
      tmdb_original_language: tmdbMovie.original_language,
      status: release.status === 'ATTENTION_NEEDED' ? 'NEW' : release.status, // Clear attention needed if it was set
    };
    
    releasesModel.upsert(updatedRelease);

    res.json({ 
      success: true, 
      message: `TMDB ID updated to ${tmdbId} (${tmdbMovie.title})`,
      tmdbTitle: tmdbMovie.title,
    });
  } catch (error) {
    console.error('Override TMDB ID error:', error);
    res.status(500).json({ error: 'Failed to override TMDB ID' });
  }
});

export default router;

