/**
 * Update sonarr_series_title for Kurukshetra releases
 */

import db from '../src/db';

async function updateSonarrTitle() {
  console.log('Updating sonarr_series_title for Kurukshetra releases...\n');
  
  // Update sonarr_series_title to match the correct show name
  const result = db.prepare(`
    UPDATE tv_releases
    SET sonarr_series_title = ?
    WHERE tvdb_id = 468042
  `).run('कुरूक्षेत्र');
  
  console.log(`✅ Updated ${result.changes} release(s) with correct sonarr_series_title`);
  
  // Verify
  const releases = db.prepare(`
    SELECT id, show_name, sonarr_series_title, tvdb_id
    FROM tv_releases
    WHERE tvdb_id = 468042
  `).all() as any[];
  
  console.log('\nUpdated releases:');
  releases.forEach(r => {
    console.log(`  ID ${r.id}: show_name="${r.show_name}", sonarr_series_title="${r.sonarr_series_title}"`);
  });
  
  process.exit(0);
}

updateSonarrTitle().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


