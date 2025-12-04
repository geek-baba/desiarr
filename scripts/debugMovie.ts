import { RadarrClient } from '../src/radarr/client';
import { TMDBClient } from '../src/tmdb/client';
import { settingsModel } from '../src/models/settings';
import db from '../src/db';

const radarrId = 3384;
const tmdbId = 522387;

async function debugMovie() {
  console.log('=== DEBUGGING MOVIE ===');
  console.log(`Radarr ID: ${radarrId}`);
  console.log(`TMDB ID: ${tmdbId}`);
  console.log('');

  // 1. Check local database
  console.log('--- LOCAL DATABASE ---');
  const dbMovie = db.prepare('SELECT * FROM radarr_movies WHERE radarr_id = ?').get(radarrId) as any;
  if (dbMovie) {
    console.log(`Title: ${dbMovie.title}`);
    console.log(`Original Language (stored): ${dbMovie.original_language || 'NULL'}`);
    console.log(`Synced at: ${dbMovie.synced_at}`);
  } else {
    console.log('NOT FOUND in local database');
  }
  console.log('');

  // 2. Check TMDB cache
  console.log('--- TMDB CACHE ---');
  const tmdbCache = db.prepare('SELECT original_language FROM tmdb_movie_cache WHERE tmdb_id = ?').get(tmdbId) as { original_language: string | null } | undefined;
  if (tmdbCache) {
    console.log(`Original Language (TMDB cache): ${tmdbCache.original_language || 'NULL'}`);
  } else {
    console.log('NOT FOUND in TMDB cache');
  }
  console.log('');

  // 3. Check Radarr API
  console.log('--- RADARR API (CURRENT) ---');
  const radarrClient = new RadarrClient();
  const radarrConfig = settingsModel.get('radarr_api_url');
  const radarrKey = settingsModel.get('radarr_api_key');
  
  if (!radarrConfig || !radarrKey) {
    console.log('Radarr not configured');
  } else {
    radarrClient.updateConfig();
    try {
      const radarrMovie = await radarrClient.getMovie(radarrId);
      if (radarrMovie) {
        console.log(`Title: ${radarrMovie.title}`);
        console.log(`Original Language (Radarr API): ${radarrMovie.originalLanguage?.name || 'NULL'}`);
        console.log(`Original Language ID: ${radarrMovie.originalLanguage?.id || 'NULL'}`);
        if (radarrMovie.movieFile) {
          console.log(`File Language: ${radarrMovie.movieFile.language?.name || 'NULL'}`);
          console.log(`MediaInfo Audio Languages: ${JSON.stringify(radarrMovie.movieFile.mediaInfo?.audioLanguages || 'NULL')}`);
        }
      } else {
        console.log('NOT FOUND in Radarr API');
      }
    } catch (error: any) {
      console.error('Error fetching from Radarr:', error?.message || error);
    }
  }
  console.log('');

  // 4. Check TMDB API
  console.log('--- TMDB API (CURRENT) ---');
  const tmdbClient = new TMDBClient();
  const tmdbKey = settingsModel.get('tmdb_api_key');
  
  if (!tmdbKey) {
    console.log('TMDB not configured');
  } else {
    tmdbClient.setApiKey(tmdbKey);
    try {
      const tmdbMovie = await tmdbClient.getMovie(tmdbId);
      if (tmdbMovie) {
        console.log(`Title: ${tmdbMovie.title}`);
        console.log(`Original Language (TMDB API): ${tmdbMovie.original_language || 'NULL'}`);
      } else {
        console.log('NOT FOUND in TMDB API');
      }
    } catch (error: any) {
      console.error('Error fetching from TMDB:', error?.message || error);
    }
  }
  console.log('');

  console.log('=== SUMMARY ===');
  console.log('Issue: Database has "Russian" but TMDB/MediaInfo show Hindi');
  console.log('Solution: Sync Radarr movies to update database with current Radarr data');
}

debugMovie().catch(console.error);

