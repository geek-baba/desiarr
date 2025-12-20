#!/usr/bin/env tsx
/**
 * Script to fix specific TV show matching issues
 * Fixes:
 * 1. Rise and Fall (2025) - Update TVDB ID to 468133
 * 2. Scam 1992 - Update show name
 * 3. 90's A Middle Class Biopic - Fix TVDB ID (remove incorrect 425282)
 * 4. Azad - Fix TVDB ID (remove incorrect 264497) and TMDB/IMDB IDs
 */

import db from '../src/db/index.js';
import tvdbClient from '../src/tvdb/client.js';
import tmdbClient from '../src/tmdb/client.js';
import { settingsModel } from '../src/models/settings.js';

interface TvRelease {
  id: number;
  guid: string;
  title: string;
  show_name: string;
  tvdb_id: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  tvdb_title: string | null;
  tmdb_title: string | null;
}

async function fixRiseAndFall() {
  console.log('\n=== Fixing Rise and Fall (2025) ===');
  
  // Find all releases with "Rise and Fall" or "Rise And Fall"
  const releases = db.prepare(`
    SELECT * FROM tv_releases 
    WHERE show_name LIKE '%Rise%Fall%' OR title LIKE '%Rise%Fall%'
    ORDER BY id DESC
  `).all() as TvRelease[];
  
  if (releases.length === 0) {
    console.log('No "Rise and Fall" releases found');
    return;
  }
  
  console.log(`Found ${releases.length} release(s)`);
  
  const correctTvdbId = 468133;
  const allSettings = db.prepare('SELECT key, value FROM app_settings').all() as Array<{key: string; value: string}>;
  const tvdbApiKey = allSettings.find((s: any) => s.key === 'tvdb_api_key')?.value;
  const tmdbApiKey = allSettings.find((s: any) => s.key === 'tmdb_api_key')?.value;
  
  if (!tvdbApiKey) {
    console.log('TVDB API key not configured');
    return;
  }
  
  tvdbClient.updateConfig();
  
  // Get correct info from TVDB
  try {
    const tvdbExtended = await tvdbClient.getSeriesExtended(correctTvdbId);
    if (!tvdbExtended) {
      console.log(`Failed to fetch TVDB info for ID ${correctTvdbId}`);
      return;
    }
    
    const tvdbTitle = (tvdbExtended as any).name || (tvdbExtended as any).title || 'Rise and Fall';
    console.log(`TVDB Title: ${tvdbTitle}`);
    
    // Get TMDB ID from TVDB
    const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids || [];
    const tmdbRemote = remoteIds.find((r: any) => 
      r.sourceName === 'TheMovieDB.com' || r.sourceName === 'TheMovieDB' ||
      r.source_name === 'TheMovieDB.com' || r.source_name === 'TheMovieDB' ||
      r.source === 'themoviedb'
    );
    const imdbRemote = remoteIds.find((r: any) => 
      r.sourceName === 'IMDB' || r.source_name === 'IMDB' || r.source === 'imdb'
    );
    
    let tmdbId = null;
    let imdbId = null;
    let tmdbTitle = null;
    
    if (tmdbRemote && tmdbRemote.id && tmdbApiKey) {
      tmdbId = parseInt(String(tmdbRemote.id), 10);
      console.log(`TMDB ID from TVDB: ${tmdbId}`);
      
      // Get English title from TMDB
      try {
        const tmdbShow = await tmdbClient.getTvShow(tmdbId);
        if (tmdbShow && tmdbShow.name) {
          tmdbTitle = tmdbShow.name;
          console.log(`TMDB Title: ${tmdbTitle}`);
          
          if (tmdbShow.external_ids?.imdb_id) {
            imdbId = tmdbShow.external_ids.imdb_id;
            console.log(`IMDB ID from TMDB: ${imdbId}`);
          }
        }
      } catch (error) {
        console.log(`Failed to fetch TMDB info: ${error}`);
      }
    }
    
    if (imdbRemote && imdbRemote.id && !imdbId) {
      imdbId = String(imdbRemote.id);
      console.log(`IMDB ID from TVDB: ${imdbId}`);
    }
    
    // Update all releases
    for (const release of releases) {
      console.log(`\nUpdating release ID ${release.id}: "${release.show_name}"`);
      console.log(`  Current: TVDB=${release.tvdb_id}, TMDB=${release.tmdb_id}, IMDB=${release.imdb_id}`);
      console.log(`  New:     TVDB=${correctTvdbId}, TMDB=${tmdbId}, IMDB=${imdbId}`);
      
      db.prepare(`
        UPDATE tv_releases SET
          tvdb_id = ?,
          tmdb_id = ?,
          imdb_id = ?,
          tvdb_title = ?,
          tmdb_title = ?,
          show_name = ?,
          sonarr_series_title = ?,
          last_checked_at = datetime('now')
        WHERE id = ?
      `).run(
        correctTvdbId,
        tmdbId,
        imdbId,
        tmdbTitle || tvdbTitle,
        tmdbTitle,
        tmdbTitle || tvdbTitle || 'Rise and Fall',
        tmdbTitle || tvdbTitle || 'Rise and Fall', // Also update sonarr_series_title
        release.id
      );
      
      console.log(`  ✓ Updated`);
    }
  } catch (error) {
    console.error(`Error fixing Rise and Fall:`, error);
  }
}

async function fixScam1992() {
  console.log('\n=== Fixing Scam 1992 - The Harshad Mehta Story ===');
  
  const releases = db.prepare(`
    SELECT * FROM tv_releases 
    WHERE show_name LIKE '%Scam%1992%' OR title LIKE '%Scam%1992%'
    ORDER BY id DESC
  `).all() as TvRelease[];
  
  if (releases.length === 0) {
    console.log('No "Scam 1992" releases found');
    return;
  }
  
  console.log(`Found ${releases.length} release(s)`);
  
  const correctShowName = 'Scam 1992: The Harshad Mehta Story';
  
  for (const release of releases) {
    console.log(`\nUpdating release ID ${release.id}: "${release.show_name}"`);
    
    // If we have correct IDs, just update the show name
    if (release.tvdb_id || release.tmdb_id) {
      db.prepare(`
        UPDATE tv_releases SET
          show_name = ?,
          sonarr_series_title = ?,
          last_checked_at = datetime('now')
        WHERE id = ?
      `).run(correctShowName, correctShowName, release.id); // Update both show_name and sonarr_series_title
      
      console.log(`  ✓ Updated show name to "${correctShowName}"`);
    } else {
      console.log(`  ⚠ No IDs found, skipping`);
    }
  }
}

async function fix90sMiddleClassBiopic() {
  console.log('\n=== Fixing 90\'s A Middle Class Biopic ===');
  
  const releases = db.prepare(`
    SELECT * FROM tv_releases 
    WHERE show_name LIKE '%90%Middle%Class%Biopic%' 
       OR title LIKE '%90%Middle%Class%Biopic%'
       OR show_name LIKE '%Class%' AND (tvdb_id = 425282 OR tmdb_id IS NULL)
    ORDER BY id DESC
  `).all() as TvRelease[];
  
  if (releases.length === 0) {
    console.log('No "90\'s A Middle Class Biopic" releases found');
    return;
  }
  
  console.log(`Found ${releases.length} release(s)`);
  
  const correctShowName = "90's A Middle Class Biopic";
  
  // Remove incorrect TVDB ID (425282 is "Class") and fix titles
  for (const release of releases) {
    console.log(`\nUpdating release ID ${release.id}: "${release.show_name}"`);
    console.log(`  Current: TVDB=${release.tvdb_id}, show_name="${release.show_name}", tvdb_title="${release.tvdb_title}", tmdb_title="${release.tmdb_title}"`);
    
    // Check if this is the wrong show (Class instead of 90's A Middle Class Biopic)
    const isWrongMatch = release.tvdb_id === 425282 || 
                        release.show_name === 'Class' || 
                        release.tvdb_title === 'Class' ||
                        release.tmdb_title === 'Class';
    
    if (isWrongMatch) {
      console.log(`  ⚠ Removing incorrect match to "Class" (TVDB 425282)`);
      
      db.prepare(`
        UPDATE tv_releases SET
          tvdb_id = NULL,
          tvdb_title = NULL,
          tmdb_title = NULL,
          show_name = ?,
          sonarr_series_title = NULL,
          last_checked_at = datetime('now')
        WHERE id = ?
      `).run(correctShowName, release.id);
      
      console.log(`  ✓ Cleared incorrect IDs and updated show name to "${correctShowName}"`);
      
      // Also clear TVDB ID from RSS feed items for this release
      const rssItems = db.prepare(`
        SELECT id, tvdb_id FROM rss_feed_items WHERE guid = ?
      `).all(release.guid) as Array<{id: number; tvdb_id: number | null}>;
      
      for (const rssItem of rssItems) {
        if (rssItem.tvdb_id === 425282) {
          console.log(`  ✓ Clearing TVDB ID from RSS feed item ${rssItem.id}`);
          db.prepare(`
            UPDATE rss_feed_items SET
              tvdb_id = NULL,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(rssItem.id);
        }
      }
    } else if (release.show_name !== correctShowName) {
      // Just update the show name if it's different
      console.log(`  ✓ Updating show name to "${correctShowName}"`);
      
      db.prepare(`
        UPDATE tv_releases SET
          show_name = ?,
          sonarr_series_title = ?,
          last_checked_at = datetime('now')
        WHERE id = ?
      `).run(correctShowName, correctShowName, release.id);
    } else {
      console.log(`  ℹ Already correct, skipping`);
    }
  }
}

async function fixAzad() {
  console.log('\n=== Fixing Azad ===');
  
  const releases = db.prepare(`
    SELECT * FROM tv_releases 
    WHERE show_name LIKE '%Azad%' OR title LIKE '%Azad%'
    ORDER BY id DESC
  `).all() as TvRelease[];
  
  if (releases.length === 0) {
    console.log('No "Azad" releases found');
    return;
  }
  
  console.log(`Found ${releases.length} release(s)`);
  
  // Remove incorrect TVDB ID (264497 is "Le Mille E Una Notte")
  // Remove incorrect TMDB/IMDB IDs (they're for a 2002 show)
  for (const release of releases) {
    console.log(`\nUpdating release ID ${release.id}: "${release.show_name}"`);
    console.log(`  Current: TVDB=${release.tvdb_id}, TMDB=${release.tmdb_id}, IMDB=${release.imdb_id}`);
    
    let needsUpdate = false;
    
    if (release.tvdb_id === 264497) {
      console.log(`  ⚠ Removing incorrect TVDB ID 264497 (this is "Le Mille E Una Notte", not "Azad")`);
      needsUpdate = true;
    }
    
    // Check if TMDB/IMDB IDs are for 2002 show (likely incorrect)
    // We'll clear them and let the matching engine find the correct ones
    if (release.tmdb_id || release.imdb_id) {
      console.log(`  ⚠ Clearing TMDB/IMDB IDs to allow re-matching`);
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      db.prepare(`
        UPDATE tv_releases SET
          tvdb_id = NULL,
          tmdb_id = NULL,
          imdb_id = NULL,
          tvdb_title = NULL,
          tmdb_title = NULL,
          last_checked_at = datetime('now')
        WHERE id = ?
      `).run(release.id);
      
      console.log(`  ✓ Cleared incorrect IDs - will be re-matched on next sync`);
    } else {
      console.log(`  ℹ No incorrect IDs found`);
    }
  }
}

async function main() {
  console.log('Starting TV show fixes...\n');
  
  // Load API keys
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  
  if (tvdbApiKey) {
    tvdbClient.updateConfig();
  }
  
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
  }
  
  try {
    await fixRiseAndFall();
    await fixScam1992();
    await fix90sMiddleClassBiopic();
    await fixAzad();
    
    console.log('\n✅ All fixes completed!');
  } catch (error) {
    console.error('\n❌ Error during fixes:', error);
    process.exit(1);
  }
}

main();

