#!/usr/bin/env tsx
/**
 * Script to check mismatched Sonarr shows
 */

import db from '../src/db/index.js';

console.log('=== Checking Mismatched Shows ===\n');

// Check tv_releases for the problematic shows
const shows = [
  { pattern: '%Bad Boy%', name: 'Bad Boy Billionaires India' },
  { pattern: '%90%Middle%Class%', name: "90's A Middle Class Biopic" },
  { pattern: '%Prayagraj%', name: 'Prayagraj Ki Love Story' },
  { pattern: '%Class%', name: 'Class' },
];

for (const show of shows) {
  console.log(`\n--- ${show.name} ---`);
  
  // Check tv_releases
  const releases = db.prepare(`
    SELECT id, title, show_name, tvdb_id, tmdb_id, imdb_id, 
           sonarr_series_id, sonarr_series_title, status, guid
    FROM tv_releases 
    WHERE show_name LIKE ? OR title LIKE ?
    ORDER BY id DESC
    LIMIT 5
  `).all(show.pattern, show.pattern) as any[];
  
  if (releases.length > 0) {
    for (const release of releases) {
      console.log(`  Release ID: ${release.id}`);
      console.log(`    Title: ${release.title}`);
      console.log(`    Show Name: ${release.show_name}`);
      console.log(`    TVDB ID: ${release.tvdb_id || 'NULL'}`);
      console.log(`    TMDB ID: ${release.tmdb_id || 'NULL'}`);
      console.log(`    IMDB ID: ${release.imdb_id || 'NULL'}`);
      console.log(`    Sonarr Series ID: ${release.sonarr_series_id || 'NULL'}`);
      console.log(`    Sonarr Series Title: ${release.sonarr_series_title || 'NULL'}`);
      console.log(`    Status: ${release.status}`);
      console.log(`    GUID: ${release.guid}`);
      
      // Check RSS feed item
      const rssItem = db.prepare('SELECT id, title, tvdb_id, tmdb_id, imdb_id, tvdb_id_manual, tmdb_id_manual FROM rss_feed_items WHERE guid = ?').get(release.guid) as any;
      if (rssItem) {
        console.log(`    RSS Item ID: ${rssItem.id}`);
        console.log(`    RSS TVDB ID: ${rssItem.tvdb_id || 'NULL'} (manual: ${rssItem.tvdb_id_manual || 0})`);
        console.log(`    RSS TMDB ID: ${rssItem.tmdb_id || 'NULL'} (manual: ${rssItem.tmdb_id_manual || 0})`);
        console.log(`    RSS IMDB ID: ${rssItem.imdb_id || 'NULL'}`);
      }
      
      // Check Sonarr show if sonarr_series_id exists
      if (release.sonarr_series_id) {
        const sonarrShow = db.prepare('SELECT sonarr_id, title, tvdb_id, tmdb_id, imdb_id FROM sonarr_shows WHERE sonarr_id = ?').get(release.sonarr_series_id) as any;
        if (sonarrShow) {
          console.log(`    Sonarr Show: "${sonarrShow.title}"`);
          console.log(`      Sonarr TVDB ID: ${sonarrShow.tvdb_id || 'NULL'}`);
          console.log(`      Sonarr TMDB ID: ${sonarrShow.tmdb_id || 'NULL'}`);
          console.log(`      Sonarr IMDB ID: ${sonarrShow.imdb_id || 'NULL'}`);
          
          // Check if IDs match
          if (release.tvdb_id && sonarrShow.tvdb_id && release.tvdb_id !== sonarrShow.tvdb_id) {
            console.log(`    ⚠️ TVDB ID MISMATCH: Release has ${release.tvdb_id}, Sonarr has ${sonarrShow.tvdb_id}`);
          }
          if (release.tmdb_id && sonarrShow.tmdb_id && release.tmdb_id !== sonarrShow.tmdb_id) {
            console.log(`    ⚠️ TMDB ID MISMATCH: Release has ${release.tmdb_id}, Sonarr has ${sonarrShow.tmdb_id}`);
          }
          if (release.imdb_id && sonarrShow.imdb_id && release.imdb_id !== sonarrShow.imdb_id) {
            console.log(`    ⚠️ IMDB ID MISMATCH: Release has ${release.imdb_id}, Sonarr has ${sonarrShow.imdb_id}`);
          }
        } else {
          console.log(`    ⚠️ Sonarr show ${release.sonarr_series_id} not found in sonarr_shows table`);
        }
      }
      console.log('');
    }
  } else {
    console.log('  No releases found');
  }
}

console.log('\n=== Done ===');
