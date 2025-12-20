/**
 * Check TV release data for Kurukshetra/She
 */

import db from '../src/db';

async function checkTvRelease() {
  console.log('Checking TV releases for Kurukshetra/She...\n');
  
  // Find releases with Kurukshetra in title or show_name
  const releases = db.prepare(`
    SELECT id, guid, title, show_name, tvdb_id, tmdb_id, sonarr_series_title, sonarr_series_id, status, last_checked_at
    FROM tv_releases
    WHERE title LIKE '%Kurukshetra%' OR show_name LIKE '%Kurukshetra%' OR show_name LIKE '%She%'
    ORDER BY id DESC
    LIMIT 10
  `).all() as any[];
  
  console.log(`Found ${releases.length} release(s):\n`);
  
  releases.forEach((r, idx) => {
    console.log(`[${idx + 1}] ID: ${r.id}`);
    console.log(`    Title: ${r.title}`);
    console.log(`    Show Name: ${r.show_name}`);
    console.log(`    Sonarr Series Title: ${r.sonarr_series_title || 'null'}`);
    console.log(`    TVDB ID: ${r.tvdb_id || 'null'}`);
    console.log(`    TMDB ID: ${r.tmdb_id || 'null'}`);
    console.log(`    Sonarr Series ID: ${r.sonarr_series_id || 'null'}`);
    console.log(`    Status: ${r.status}`);
    console.log(`    Last Checked: ${r.last_checked_at}`);
    console.log('');
  });
  
  // Check RSS feed items
  console.log('\nChecking RSS feed items...\n');
  const rssItems = db.prepare(`
    SELECT id, guid, title, tvdb_id, tmdb_id, tvdb_id_manual, tmdb_id_manual
    FROM rss_feed_items
    WHERE title LIKE '%Kurukshetra%'
    ORDER BY id DESC
    LIMIT 5
  `).all() as any[];
  
  console.log(`Found ${rssItems.length} RSS item(s):\n`);
  
  rssItems.forEach((item, idx) => {
    console.log(`[${idx + 1}] ID: ${item.id}`);
    console.log(`    Title: ${item.title}`);
    console.log(`    TVDB ID: ${item.tvdb_id || 'null'} (manual: ${item.tvdb_id_manual || 0})`);
    console.log(`    TMDB ID: ${item.tmdb_id || 'null'} (manual: ${item.tmdb_id_manual || 0})`);
    console.log('');
  });
  
  process.exit(0);
}

checkTvRelease().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


