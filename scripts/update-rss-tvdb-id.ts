/**
 * Update RSS feed items with correct TVDB ID for Kurukshetra
 */

import db from '../src/db';

async function updateRssTvdbId() {
  console.log('Updating RSS feed items with correct TVDB ID...\n');
  
  // Find RSS items with wrong TVDB ID
  const rssItems = db.prepare(`
    SELECT id, guid, title, tvdb_id, tmdb_id, tvdb_id_manual, tmdb_id_manual
    FROM rss_feed_items
    WHERE (tvdb_id = 378181 OR title LIKE '%Kurukshetra%')
    ORDER BY id DESC
  `).all() as any[];
  
  console.log(`Found ${rssItems.length} RSS item(s) to check:\n`);
  
  for (const item of rssItems) {
    console.log(`Processing RSS item ID ${item.id}:`);
    console.log(`  Title: ${item.title}`);
    console.log(`  Current TVDB ID: ${item.tvdb_id || 'null'} (manual: ${item.tvdb_id_manual || 0})`);
    console.log(`  Current TMDB ID: ${item.tmdb_id || 'null'} (manual: ${item.tmdb_id_manual || 0})`);
    
    // Check if TVDB ID is wrong (378181 = "She")
    if (item.tvdb_id === 378181 && item.title.includes('Kurukshetra')) {
      console.log(`  ⚠️  Wrong TVDB ID detected (378181 = "She")`);
      console.log(`  → Updating TVDB ID to 468042 (Kurukshetra)`);
      
      // Update the RSS item
      db.prepare(`
        UPDATE rss_feed_items
        SET tvdb_id = 468042,
            tvdb_id_manual = 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(item.id);
      
      console.log(`  ✅ Updated RSS item ID ${item.id} with correct TVDB ID`);
    } else if (item.title.includes('Kurukshetra') && !item.tvdb_id) {
      console.log(`  → No TVDB ID, setting to 468042 (Kurukshetra)`);
      
      db.prepare(`
        UPDATE rss_feed_items
        SET tvdb_id = 468042,
            tvdb_id_manual = 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(item.id);
      
      console.log(`  ✅ Updated RSS item ID ${item.id} with correct TVDB ID`);
    } else {
      console.log(`  ✓ TVDB ID is correct or not applicable`);
    }
    
    console.log('');
  }
  
  console.log('Done!');
  process.exit(0);
}

updateRssTvdbId().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


