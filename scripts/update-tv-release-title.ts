/**
 * Update TV release show_name based on TVDB ID
 */

import db from '../src/db';
import tvdbClient from '../src/tvdb/client';
import { settingsModel } from '../src/models/settings';

async function updateTvReleaseTitle() {
  console.log('Updating TV release titles from TVDB...\n');
  
  // Get TVDB API key
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  
  if (!tvdbApiKey) {
    console.log('❌ TVDB API key not configured');
    process.exit(1);
  }
  
  tvdbClient.updateConfig();
  
  // Find releases with TVDB ID 378181 (wrong - "She") that should be 468042 (Kurukshetra)
  const releases = db.prepare(`
    SELECT id, guid, title, show_name, tvdb_id, tmdb_id
    FROM tv_releases
    WHERE (tvdb_id = 378181 OR tvdb_id = 468042) OR title LIKE '%Kurukshetra%'
    ORDER BY id DESC
  `).all() as any[];
  
  console.log(`Found ${releases.length} release(s) to check:\n`);
  
  for (const release of releases) {
    console.log(`Processing release ID ${release.id}:`);
    console.log(`  Title: ${release.title}`);
    console.log(`  Current show_name: ${release.show_name}`);
    console.log(`  TVDB ID: ${release.tvdb_id || 'null'}`);
    console.log(`  TMDB ID: ${release.tmdb_id || 'null'}`);
    
    // Check if TVDB ID is wrong (378181 = "She")
    if (release.tvdb_id === 378181) {
      console.log(`  ⚠️  Wrong TVDB ID detected (378181 = "She")`);
      
      // Check if we should update to 468042 (Kurukshetra)
      if (release.title.includes('Kurukshetra')) {
        console.log(`  → Updating TVDB ID to 468042 (Kurukshetra)`);
        
        try {
          // Fetch correct show info from TVDB
          const tvdbExtended = await tvdbClient.getSeriesExtended(468042);
          if (tvdbExtended) {
            // Get English title from TMDB if available, otherwise use TVDB title
            let correctTitle: string | null = null;
            
            // Try to get TMDB ID from TVDB extended info
            const remoteIds = (tvdbExtended as any).remoteIds || [];
            const tmdbRemote = remoteIds.find((r: any) => 
              r.sourceName === 'TheMovieDB.com' || 
              r.sourceName === 'TheMovieDB' || 
              r.source_name === 'TheMovieDB.com' || 
              r.source_name === 'TheMovieDB' ||
              r.source === 'themoviedb'
            );
            
            if (tmdbRemote && tmdbRemote.id) {
              const tmdbId = parseInt(tmdbRemote.id, 10);
              // Get English title from TMDB
              const tmdbClient = require('../src/tmdb/client').default;
              const allSettings = settingsModel.getAll();
              const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
              
              if (tmdbApiKey) {
                tmdbClient.setApiKey(tmdbApiKey);
                try {
                  const tmdbShow = await tmdbClient.getTvShow(tmdbId);
                  if (tmdbShow && tmdbShow.name) {
                    correctTitle = tmdbShow.name; // Prefer TMDB English title
                    console.log(`  → English title from TMDB: ${correctTitle}`);
                  }
                } catch (error) {
                  // Ignore TMDB errors
                }
              }
            }
            
            // Fallback to TVDB title if TMDB title not available
            if (!correctTitle) {
              correctTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || 'Kurukshetra';
              console.log(`  → Title from TVDB: ${correctTitle}`);
            }
            
            // Update the release
            db.prepare(`
              UPDATE tv_releases
              SET tvdb_id = 468042,
                  show_name = ?,
                  sonarr_series_title = ?,
                  last_checked_at = datetime('now')
              WHERE id = ?
            `).run(correctTitle, correctTitle, release.id);
            
            console.log(`  ✅ Updated release ID ${release.id} with correct TVDB ID and English title`);
          }
        } catch (error: any) {
          console.log(`  ❌ Error fetching TVDB info: ${error?.message || error}`);
        }
      }
    } else if (release.tvdb_id === 468042) {
      // Already has correct TVDB ID, just update title if needed
      console.log(`  ✓ Correct TVDB ID (468042)`);
      
      try {
        const tvdbExtended = await tvdbClient.getSeriesExtended(468042);
        if (tvdbExtended) {
          // Get English title from TMDB if available
          let correctTitle: string | null = null;
          
          // Try to get TMDB ID from TVDB extended info
          const remoteIds = (tvdbExtended as any).remoteIds || [];
          const tmdbRemote = remoteIds.find((r: any) => 
            r.sourceName === 'TheMovieDB.com' || 
            r.sourceName === 'TheMovieDB' || 
            r.source_name === 'TheMovieDB.com' || 
            r.source_name === 'TheMovieDB' ||
            r.source === 'themoviedb'
          );
          
          if (tmdbRemote && tmdbRemote.id) {
            const tmdbId = parseInt(tmdbRemote.id, 10);
            // Get English title from TMDB
            const tmdbClient = require('../src/tmdb/client').default;
            const allSettings = settingsModel.getAll();
            const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
            
            if (tmdbApiKey) {
              tmdbClient.setApiKey(tmdbApiKey);
              try {
                const tmdbShow = await tmdbClient.getTvShow(tmdbId);
                if (tmdbShow && tmdbShow.name) {
                  correctTitle = tmdbShow.name; // Prefer TMDB English title
                  console.log(`  → English title from TMDB: ${correctTitle}`);
                }
              } catch (error) {
                // Ignore TMDB errors
              }
            }
          }
          
          // Fallback to TVDB title if TMDB title not available
          if (!correctTitle) {
            correctTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || 'Kurukshetra';
            console.log(`  → Title from TVDB: ${correctTitle}`);
          }
          
          if (release.show_name !== correctTitle || release.sonarr_series_title !== correctTitle) {
            console.log(`  → Updating show_name and sonarr_series_title from "${release.show_name}" to "${correctTitle}"`);
            db.prepare(`
              UPDATE tv_releases
              SET show_name = ?,
                  sonarr_series_title = ?,
                  last_checked_at = datetime('now')
              WHERE id = ?
            `).run(correctTitle, correctTitle, release.id);
            console.log(`  ✅ Updated titles`);
          } else {
            console.log(`  ✓ Titles are already correct`);
          }
        }
      } catch (error: any) {
        console.log(`  ❌ Error fetching TVDB info: ${error?.message || error}`);
      }
    }
    
    console.log('');
  }
  
  console.log('Done!');
  process.exit(0);
}

updateTvReleaseTitle().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

