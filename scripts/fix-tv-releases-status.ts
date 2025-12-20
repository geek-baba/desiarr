/**
 * Fix TV releases that have sonarr_series_id but incorrect status
 * This fixes shows that were manually added to Sonarr but got their status
 * changed to NEW_SHOW or NEW_SEASON when the matching engine ran
 */

import db from '../src/db';

console.log('🔍 Finding TV releases with sonarr_series_id but incorrect status...\n');

// Find all TV releases that have sonarr_series_id but status is not ADDED or IGNORED
const affectedReleases = db.prepare(`
  SELECT id, title, show_name, sonarr_series_id, sonarr_series_title, status
  FROM tv_releases
  WHERE sonarr_series_id IS NOT NULL
    AND status NOT IN ('ADDED', 'IGNORED')
  ORDER BY published_at DESC
`).all() as Array<{
  id: number;
  title: string;
  show_name: string;
  sonarr_series_id: number;
  sonarr_series_title: string | null;
  status: string;
}>;

// Also check for releases that might have been in Sonarr but lost their sonarr_series_id
// Check if there are any shows in sonarr_shows that match TV releases by TVDB/TMDB ID
// but the release doesn't have sonarr_series_id
const releasesWithMissingSonarrId = db.prepare(`
  SELECT DISTINCT r.id, r.title, r.show_name, r.tvdb_id, r.tmdb_id, r.status,
         s.sonarr_id, s.title as sonarr_title
  FROM tv_releases r
  INNER JOIN sonarr_shows s ON (
    (r.tvdb_id IS NOT NULL AND r.tvdb_id = s.tvdb_id) OR
    (r.tmdb_id IS NOT NULL AND r.tmdb_id = s.tmdb_id)
  )
  WHERE r.sonarr_series_id IS NULL
    AND r.status NOT IN ('IGNORED')
  ORDER BY r.published_at DESC
  LIMIT 50
`).all() as Array<{
  id: number;
  title: string;
  show_name: string;
  tvdb_id: number | null;
  tmdb_id: number | null;
  status: string;
  sonarr_id: number;
  sonarr_title: string;
}>;

if (affectedReleases.length === 0 && releasesWithMissingSonarrId.length === 0) {
  console.log('✅ No affected releases found. All TV releases have correct status and sonarr_series_id.');
  process.exit(0);
}

const totalAffected = affectedReleases.length + releasesWithMissingSonarrId.length;
console.log(`Found ${totalAffected} affected release(s):\n`);

if (affectedReleases.length > 0) {
  console.log(`\n📋 Releases with sonarr_series_id but wrong status (${affectedReleases.length}):\n`);
  affectedReleases.forEach((release, index) => {
    console.log(`${index + 1}. "${release.show_name}" (ID: ${release.id})`);
    console.log(`   Title: ${release.title}`);
    console.log(`   Sonarr Series ID: ${release.sonarr_series_id}`);
    console.log(`   Sonarr Series Title: ${release.sonarr_series_title || 'N/A'}`);
    console.log(`   Current Status: ${release.status}`);
    console.log(`   → Will be updated to: ADDED\n`);
  });
}

if (releasesWithMissingSonarrId.length > 0) {
  console.log(`\n📋 Releases that should have sonarr_series_id but it's missing (${releasesWithMissingSonarrId.length}):\n`);
  releasesWithMissingSonarrId.forEach((release, index) => {
    console.log(`${index + 1}. "${release.show_name}" (ID: ${release.id})`);
    console.log(`   Title: ${release.title}`);
    console.log(`   TVDB ID: ${release.tvdb_id || 'N/A'}, TMDB ID: ${release.tmdb_id || 'N/A'}`);
    console.log(`   Found in Sonarr: ${release.sonarr_title} (Sonarr ID: ${release.sonarr_id})`);
    console.log(`   Current Status: ${release.status}`);
    console.log(`   → Will set sonarr_series_id to: ${release.sonarr_id} and status to: ADDED\n`);
  });
}

console.log('⚠️  This will:');
if (affectedReleases.length > 0) {
  console.log(`   - Update ${affectedReleases.length} release(s) status to "ADDED"`);
}
if (releasesWithMissingSonarrId.length > 0) {
  console.log(`   - Set sonarr_series_id for ${releasesWithMissingSonarrId.length} release(s) and update status to "ADDED"`);
}
console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');

// Wait 5 seconds before proceeding
setTimeout(() => {
  console.log('🔄 Updating releases...\n');

  let updatedCount = 0;

  // Fix releases with wrong status
  if (affectedReleases.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE tv_releases
      SET status = 'ADDED',
          last_checked_at = datetime('now')
      WHERE id = ?
    `);

    const updateMany = db.transaction((releases: typeof affectedReleases) => {
      let updated = 0;
      for (const release of releases) {
        const result = updateStmt.run(release.id);
        if (result.changes > 0) {
          updated++;
        }
      }
      return updated;
    });

    updatedCount += updateMany(affectedReleases);
  }

  // Fix releases with missing sonarr_series_id
  if (releasesWithMissingSonarrId.length > 0) {
    const updateMissingStmt = db.prepare(`
      UPDATE tv_releases
      SET sonarr_series_id = ?,
          sonarr_series_title = ?,
          status = 'ADDED',
          last_checked_at = datetime('now')
      WHERE id = ?
    `);

    const updateMissingMany = db.transaction((releases: typeof releasesWithMissingSonarrId) => {
      let updated = 0;
      for (const release of releases) {
        const result = updateMissingStmt.run(
          release.sonarr_id,
          release.sonarr_title,
          release.id
        );
        if (result.changes > 0) {
          updated++;
        }
      }
      return updated;
    });

    updatedCount += updateMissingMany(releasesWithMissingSonarrId);
  }

  console.log(`✅ Updated ${updatedCount} release(s).`);
  console.log('\nThese releases should now appear in "Existing TVShows" on the dashboard.');

  process.exit(0);
}, 5000);

