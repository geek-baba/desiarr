import { Router, Request, Response } from 'express';
import { releasesModel } from '../models/releases';
import { tvReleasesModel } from '../models/tvReleases';
import radarrClient from '../radarr/client';
import sonarrClient from '../sonarr/client';
import { Release } from '../types/Release';
import tmdbClient from '../tmdb/client';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';

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

    // Note: We allow adding movies regardless of release status (NEW, ATTENTION_NEEDED, or IGNORED)
    // The release status only indicates whether the release meets quality requirements, not whether
    // the movie itself can be added to Radarr. Users should be able to manually add movies even
    // if the release was marked as IGNORED.

    // TMDB ID is required - Radarr cannot add a movie without a TMDB ID
    if (!release.tmdb_id) {
      return res.status(400).json({ 
        error: 'TMDB ID is required to add movie to Radarr. Please ensure the release has a valid TMDB ID.' 
      });
    }

    const { qualityProfileId, rootFolderPath } = req.body;

    if (!qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ 
        error: 'Quality profile ID and root folder path are required' 
      });
    }

    // Lookup movie by TMDB ID (required for Radarr)
    let movie = await radarrClient.lookupMovieByTmdbId(release.tmdb_id);
    
    // Fallback to title lookup if TMDB ID lookup fails
    if (!movie) {
      console.log(`TMDB ID lookup failed for ${release.tmdb_id}, trying title lookup...`);
      const lookupResults = await radarrClient.lookupMovie(release.tmdb_title || release.title);
      movie = lookupResults.find((m) => m.tmdbId === release.tmdb_id) || null;
    }

    if (!movie) {
      return res.status(404).json({ 
        error: `Movie not found in Radarr lookup. ${release.tmdb_id ? `TMDB ID: ${release.tmdb_id}` : `Title: ${release.tmdb_title || release.title}`}` 
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

router.get('/sonarr-options', async (req: Request, res: Response) => {
  try {
    const qualityProfiles = await sonarrClient.getQualityProfiles();
    const rootFolders = await sonarrClient.getRootFolders();
    
    res.json({
      success: true,
      qualityProfiles,
      rootFolders,
    });
  } catch (error: any) {
    console.error('Get Sonarr options error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch Sonarr options',
      details: error?.message || undefined,
    });
  }
});

router.post('/tv/:id/add', async (req: Request, res: Response) => {
  try {
    const release = tvReleasesModel.getById(parseInt(req.params.id, 10));
    
    if (!release) {
      return res.status(404).json({ error: 'TV release not found' });
    }

    console.log(`Add TV show request for release ID ${req.params.id}: status=${release.status}, tvdb_id=${release.tvdb_id}, sonarr_series_id=${release.sonarr_series_id}`);

    // Check if show already exists in Sonarr
    if (release.sonarr_series_id) {
      return res.status(400).json({ 
        error: 'TV show already exists in Sonarr.' 
      });
    }

    // TVDB ID is required - Sonarr primarily uses TVDB ID
    if (!release.tvdb_id) {
      return res.status(400).json({ 
        error: 'TVDB ID is required to add TV show to Sonarr. Please ensure the release has a valid TVDB ID.' 
      });
    }

    const { qualityProfileId, rootFolderPath } = req.body;

    if (!qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ 
        error: 'Quality profile ID and root folder path are required' 
      });
    }

    // Lookup series by TVDB ID (required for Sonarr)
    let series = await sonarrClient.lookupSeriesByTvdbId(release.tvdb_id);
    
    // Fallback to term lookup if TVDB ID lookup fails
    if (!series) {
      console.log(`TVDB ID lookup failed for ${release.tvdb_id}, trying term lookup...`);
      const lookupResults = await sonarrClient.lookupSeries(release.show_name || release.title);
      series = lookupResults.find((s: any) => s.tvdbId === release.tvdb_id) || null;
    }

    if (!series) {
      return res.status(404).json({ 
        error: `TV show not found in Sonarr lookup. TVDB ID: ${release.tvdb_id}, Title: ${release.show_name || release.title}` 
      });
    }

    // Add to Sonarr with selected options
    const addedSeries = await sonarrClient.addSeries(series, parseInt(qualityProfileId, 10), rootFolderPath);

    // Update release with Sonarr series ID
    const updatedRelease = {
      ...release,
      sonarr_series_id: addedSeries.id,
      sonarr_series_title: addedSeries.title,
      status: 'ADDED' as const,
    };
    tvReleasesModel.upsert(updatedRelease);

    res.json({ 
      success: true, 
      message: `TV show "${addedSeries.title}" added to Sonarr successfully`,
      sonarrSeriesId: addedSeries.id,
    });
  } catch (error: any) {
    console.error('Add TV show error:', error);
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    res.status(500).json({ 
      error: `Failed to add TV show: ${errorMessage}`,
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

    // Update release status and mark as manually ignored
    releasesModel.updateStatus(release.id!, 'IGNORED', { manuallyIgnored: true });

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

    // Verify the TMDB ID by fetching movie details
    const tmdbMovie = await tmdbClient.getMovie(parseInt(tmdbId, 10));
    if (!tmdbMovie) {
      return res.status(404).json({ error: 'TMDB ID not found' });
    }

    // Look up movie in Radarr using the new TMDB ID
    let radarrMovie = await radarrClient.getMovie(parseInt(tmdbId, 10));
    let radarrMovieWithHistory = null;
    let existingFileAttributes = null;
    let existingFilePath = null;
    let existingSizeMb = null;
    let radarrHistory = null;

    if (radarrMovie && radarrMovie.id) {
      // Get full movie details with history
      radarrMovieWithHistory = await radarrClient.getMovieWithHistory(radarrMovie.id);
      const existingFile = radarrMovie.movieFile;
      existingSizeMb = existingFile ? existingFile.size / (1024 * 1024) : undefined;
      existingFilePath = existingFile?.relativePath || null;

      // Parse existing file attributes (same logic as fetchFeeds)
      if (existingFile) {
        const existingParsed: any = parseReleaseFromTitle(existingFile.relativePath);
        
        // Also try to get info from mediaInfo if available
        if (existingFile.mediaInfo) {
          if (existingFile.mediaInfo.videoCodec) {
            existingParsed.videoCodecFromMediaInfo = existingFile.mediaInfo.videoCodec;
            if (existingParsed.codec === 'UNKNOWN') {
              const upper = existingFile.mediaInfo.videoCodec.toUpperCase();
              if (upper.includes('264') || upper.includes('AVC') || upper.includes('H.264')) {
                existingParsed.codec = 'x264';
              } else if (upper.includes('265') || upper.includes('HEVC') || upper.includes('H.265')) {
                existingParsed.codec = 'x265';
              }
            }
          }
          if (existingFile.mediaInfo.audioCodec) {
            existingParsed.audioFromMediaInfo = existingFile.mediaInfo.audioCodec;
            existingParsed.audioChannelsFromMediaInfo = existingFile.mediaInfo.audioChannels;
            if (existingParsed.audio === 'Unknown') {
              const upper = existingFile.mediaInfo.audioCodec.toUpperCase();
              const channels = existingFile.mediaInfo.audioChannels;
              if (upper.includes('EAC3') || upper.includes('E-AC-3') || upper.includes('DDP')) {
                if (channels === 2) existingParsed.audio = 'DDP 2.0';
                else if (channels === 6) existingParsed.audio = 'DDP 5.1';
                else if (channels === 8) existingParsed.audio = 'DDP 7.1';
                else existingParsed.audio = 'DDP';
              } else if (upper.includes('AC3') || upper.includes('AC-3')) {
                if (channels === 2) existingParsed.audio = 'DD 2.0';
                else if (channels === 6) existingParsed.audio = 'DD 5.1';
                else existingParsed.audio = 'DD';
              } else if (upper.includes('TRUEHD')) {
                existingParsed.audio = 'TrueHD';
              } else if (upper.includes('ATMOS')) {
                existingParsed.audio = 'Atmos';
              } else if (upper.includes('AAC')) {
                if (channels === 2) existingParsed.audio = 'AAC 2.0';
                else if (channels === 6) existingParsed.audio = 'AAC 5.1';
                else existingParsed.audio = 'AAC';
              } else {
                existingParsed.audio = existingFile.mediaInfo.audioCodec;
              }
            }
          }
          if (existingFile.mediaInfo.audioLanguages) {
            existingParsed.audioLanguagesFromMediaInfo = existingFile.mediaInfo.audioLanguages;
          }
        }

        // Get last download from history
        let lastDownload: any = null;
        if (radarrMovieWithHistory?.history && radarrMovieWithHistory.history.length > 0) {
          const downloadEvents = radarrMovieWithHistory.history.filter((h: any) => 
            h.eventType === 'downloadFolderImported' || 
            h.eventType === 'grabbed' ||
            h.data?.downloadUrl
          );
          if (downloadEvents.length > 0) {
            downloadEvents.sort((a: any, b: any) => 
              new Date(b.date).getTime() - new Date(a.date).getTime()
            );
            lastDownload = downloadEvents[0];
          }
        }

        // Parse last download to get source tag if available
        let lastDownloadSourceTag = existingParsed?.sourceTag || 'OTHER';
        if (lastDownload && lastDownload.sourceTitle) {
          const lastDownloadParsed = parseReleaseFromTitle(lastDownload.sourceTitle);
          if (lastDownloadParsed.sourceTag && lastDownloadParsed.sourceTag !== 'OTHER') {
            lastDownloadSourceTag = lastDownloadParsed.sourceTag;
          }
        }

        existingFileAttributes = {
          path: existingFile.relativePath,
          resolution: existingParsed.resolution,
          codec: existingParsed.codec,
          sourceTag: lastDownloadSourceTag,
          audio: existingParsed.audio,
          audioFromMediaInfo: existingParsed.audioFromMediaInfo,
          audioChannelsFromMediaInfo: existingParsed.audioChannelsFromMediaInfo,
          audioLanguages: existingParsed.audioLanguagesFromMediaInfo,
          videoCodec: existingParsed.videoCodecFromMediaInfo,
          sizeMb: existingSizeMb,
          lastDownload: lastDownload ? {
            sourceTitle: lastDownload.sourceTitle,
            date: lastDownload.date,
            releaseGroup: lastDownload.data?.releaseGroup,
          } : null,
        };
        radarrHistory = radarrMovieWithHistory?.history ? JSON.stringify(radarrMovieWithHistory.history.slice(0, 10)) : null;
      }
    }

    // Update the release with the new TMDB ID and all Radarr details
    const updatedRelease: any = {
      ...release,
      tmdb_id: parseInt(tmdbId, 10),
      tmdb_title: tmdbMovie.title,
      tmdb_original_language: tmdbMovie.original_language,
      radarr_movie_id: radarrMovie?.id || null,
      radarr_movie_title: radarrMovie?.title || null,
      existing_size_mb: existingSizeMb,
      existing_file_path: existingFilePath,
      existing_file_attributes: existingFileAttributes ? JSON.stringify(existingFileAttributes) : null,
      radarr_history: radarrHistory,
      status: release.status === 'ATTENTION_NEEDED' ? 'NEW' : release.status, // Clear attention needed if it was set
    };
    
    releasesModel.upsert(updatedRelease);

    res.json({ 
      success: true, 
      message: `TMDB ID updated to ${tmdbId} (${tmdbMovie.title})${radarrMovie ? ` - Found in Radarr` : ''}`,
      tmdbTitle: tmdbMovie.title,
      foundInRadarr: !!radarrMovie,
    });
  } catch (error) {
    console.error('Override TMDB ID error:', error);
    res.status(500).json({ error: 'Failed to override TMDB ID' });
  }
});

export default router;

