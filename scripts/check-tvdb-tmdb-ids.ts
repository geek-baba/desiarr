/**
 * Check what TVDB and TMDB IDs actually map to
 */

import tvdbClient from '../src/tvdb/client';
import tmdbClient from '../src/tmdb/client';
import { settingsModel } from '../src/models/settings';

async function checkIds() {
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  
  if (!tvdbApiKey || !tmdbApiKey) {
    console.log('API keys not configured');
    process.exit(1);
  }
  
  tvdbClient.updateConfig();
  tmdbClient.setApiKey(tmdbApiKey);
  
  const checks = [
    { name: 'Azad -> Le Mille E Una Notte', tvdbId: 264497, tmdbId: 75557, imdbId: 'tt0424604' },
    { name: 'Rise and Fall', tvdbId: null, tmdbId: 300081, imdbId: 'tt1071791' },
    { name: 'Scam 1992', tvdbId: 389680, tmdbId: 111188, imdbId: 'tt12392504' },
    { name: 'Class (90s Middle Class)', tvdbId: 425282, tmdbId: 211116, imdbId: 'tt22297684' },
  ];
  
  for (const check of checks) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`CHECKING: ${check.name}`);
    console.log('='.repeat(80));
    
    if (check.tvdbId) {
      try {
        const tvdbExtended = await tvdbClient.getSeriesExtended(check.tvdbId);
        if (tvdbExtended) {
          console.log(`\nTVDB ID ${check.tvdbId}:`);
          console.log(`  Name: ${(tvdbExtended as any).name || 'N/A'}`);
          console.log(`  Slug: ${(tvdbExtended as any).slug || 'N/A'}`);
          console.log(`  First Aired: ${(tvdbExtended as any).firstAired || 'N/A'}`);
          console.log(`  Year: ${(tvdbExtended as any).year || 'N/A'}`);
          
          // Check remote IDs
          const remoteIds = (tvdbExtended as any).remoteIds || [];
          const tmdbRemote = remoteIds.find((r: any) => 
            r.sourceName === 'TheMovieDB.com' || 
            r.sourceName === 'TheMovieDB' || 
            r.source_name === 'TheMovieDB.com' || 
            r.source_name === 'TheMovieDB' ||
            r.source === 'themoviedb'
          );
          const imdbRemote = remoteIds.find((r: any) => 
            r.sourceName === 'IMDB' || 
            r.source_name === 'IMDB' || 
            r.source === 'imdb'
          );
          
          if (tmdbRemote) {
            console.log(`  TMDB ID from TVDB: ${tmdbRemote.id}`);
            if (parseInt(tmdbRemote.id, 10) !== check.tmdbId) {
              console.log(`  ⚠️ MISMATCH: TVDB says TMDB ID is ${tmdbRemote.id}, but we have ${check.tmdbId}`);
            }
          }
          if (imdbRemote) {
            console.log(`  IMDB ID from TVDB: ${imdbRemote.id}`);
            if (imdbRemote.id !== check.imdbId) {
              console.log(`  ⚠️ MISMATCH: TVDB says IMDB ID is ${imdbRemote.id}, but we have ${check.imdbId}`);
            }
          }
        }
      } catch (error: any) {
        console.log(`  ❌ TVDB error: ${error?.message || error}`);
      }
    }
    
    if (check.tmdbId) {
      try {
        const tmdbShow = await tmdbClient.getTvShow(check.tmdbId);
        if (tmdbShow) {
          console.log(`\nTMDB ID ${check.tmdbId}:`);
          console.log(`  Name: ${tmdbShow.name || 'N/A'}`);
          console.log(`  First Air Date: ${tmdbShow.first_air_date || 'N/A'}`);
          console.log(`  Original Name: ${tmdbShow.original_name || 'N/A'}`);
          console.log(`  Original Language: ${tmdbShow.original_language || 'N/A'}`);
          
          if (tmdbShow.external_ids) {
            console.log(`  IMDB ID: ${tmdbShow.external_ids.imdb_id || 'N/A'}`);
            if (tmdbShow.external_ids.imdb_id && tmdbShow.external_ids.imdb_id !== check.imdbId) {
              console.log(`  ⚠️ MISMATCH: TMDB says IMDB ID is ${tmdbShow.external_ids.imdb_id}, but we have ${check.imdbId}`);
            }
            
            console.log(`  TVDB ID: ${tmdbShow.external_ids.tvdb_id || 'N/A'}`);
            if (tmdbShow.external_ids.tvdb_id && check.tvdbId && tmdbShow.external_ids.tvdb_id !== check.tvdbId) {
              console.log(`  ⚠️ MISMATCH: TMDB says TVDB ID is ${tmdbShow.external_ids.tvdb_id}, but we have ${check.tvdbId}`);
            }
          }
        }
      } catch (error: any) {
        console.log(`  ❌ TMDB error: ${error?.message || error}`);
      }
    }
  }
  
  process.exit(0);
}

checkIds().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

