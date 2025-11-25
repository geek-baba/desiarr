/**
 * Backfill script to update all existing TV shows with TVDB slugs
 * This script fetches slugs from TVDB API for all TV releases that have a TVDB ID but no slug
 */

import db from '../src/db';
import tvdbClient from '../src/tvdb/client';
import { settingsModel } from '../src/models/settings';

async function backfillTvdbSlugs() {
  console.log('Starting TVDB slug backfill...');
  
  // Get TVDB API key
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  
  if (!tvdbApiKey) {
    console.error('TVDB API key not configured. Please add it in Settings.');
    process.exit(1);
  }
  
  // Get all TV releases with TVDB ID but no slug
  const releases = db.prepare(`
    SELECT DISTINCT tvdb_id, show_name, id
    FROM tv_releases
    WHERE tvdb_id IS NOT NULL 
      AND (tvdb_slug IS NULL OR tvdb_slug = '')
    ORDER BY tvdb_id
  `).all() as Array<{ tvdb_id: number; show_name: string; id: number }>;
  
  console.log(`Found ${releases.length} TV releases to update`);
  
  let updated = 0;
  let errors = 0;
  const processedTvdbIds = new Set<number>();
  
  for (let i = 0; i < releases.length; i++) {
    const release = releases[i];
    
    // Skip if we've already processed this TVDB ID
    if (processedTvdbIds.has(release.tvdb_id)) {
      continue;
    }
    
    try {
      console.log(`[${i + 1}/${releases.length}] Fetching slug for TVDB ID ${release.tvdb_id} (${release.show_name})...`);
      
      // Fetch extended info from TVDB API
      const tvdbExtended = await tvdbClient.getSeriesExtended(release.tvdb_id);
      
      if (tvdbExtended) {
        // Extract slug from extended info
        const slug = (tvdbExtended as any).slug || (tvdbExtended as any).nameSlug || (tvdbExtended as any).name_slug || null;
        
        if (slug) {
          // Update all releases with this TVDB ID
          const updateResult = db.prepare(`
            UPDATE tv_releases
            SET tvdb_slug = ?
            WHERE tvdb_id = ? AND (tvdb_slug IS NULL OR tvdb_slug = '')
          `).run(slug, release.tvdb_id);
          
          const count = updateResult.changes || 0;
          updated += count;
          processedTvdbIds.add(release.tvdb_id);
          console.log(`  ✓ Updated ${count} release(s) with slug: ${slug}`);
        } else {
          console.log(`  ⚠ No slug found in TVDB API response for ID ${release.tvdb_id}`);
        }
      } else {
        console.log(`  ⚠ Could not fetch extended info for TVDB ID ${release.tvdb_id}`);
      }
      
      // Rate limiting - wait a bit between requests
      if (i < releases.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
      }
    } catch (error: any) {
      errors++;
      console.error(`  ✗ Error processing TVDB ID ${release.tvdb_id}:`, error?.message || error);
    }
  }
  
  console.log(`\nBackfill complete!`);
  console.log(`  Updated: ${updated} releases`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Unique TVDB IDs processed: ${processedTvdbIds.size}`);
}

// Run if called directly
if (require.main === module) {
  backfillTvdbSlugs()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { backfillTvdbSlugs };

