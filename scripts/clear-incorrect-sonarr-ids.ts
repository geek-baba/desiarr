/**
 * Script to clear incorrect sonarr_series_id values from tv_releases
 * when the TVDB ID has changed or the show doesn't exist in Sonarr
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try multiple possible database paths
const possiblePaths = [
  process.env.DB_PATH,
  path.join(__dirname, '../data/desiarr.db'),
  path.join(__dirname, '../data/app.db'),
  '/app/data/desiarr.db',
  '/app/data/app.db',
].filter(Boolean) as string[];

let db: Database.Database | null = null;
for (const dbPath of possiblePaths) {
  try {
    db = new Database(dbPath);
    // Test if we can query
    db.prepare('SELECT 1').get();
    console.log(`Using database: ${dbPath}`);
    break;
  } catch (error) {
    // Try next path
    if (db) db.close();
    db = null;
  }
}

if (!db) {
  console.error('Could not find database file. Tried:', possiblePaths);
  process.exit(1);
}

console.log('=== Clearing Incorrect Sonarr Series IDs ===\n');

// Get all tv_releases with sonarr_series_id
const releasesWithSonarrId = db.prepare(`
  SELECT id, guid, show_name, tvdb_id, sonarr_series_id, sonarr_series_title
  FROM tv_releases
  WHERE sonarr_series_id IS NOT NULL
`).all() as Array<{
  id: number;
  guid: string;
  show_name: string | null;
  tvdb_id: number | null;
  sonarr_series_id: number;
  sonarr_series_title: string | null;
}>;

console.log(`Found ${releasesWithSonarrId.length} release(s) with sonarr_series_id\n`);

let cleared = 0;
let verified = 0;

for (const release of releasesWithSonarrId) {
  // Check if the sonarr_series_id points to a show with matching TVDB ID
  const sonarrShow = db.prepare(`
    SELECT sonarr_id, tvdb_id, title
    FROM sonarr_shows
    WHERE sonarr_id = ?
  `).get(release.sonarr_series_id) as { sonarr_id: number; tvdb_id: number | null; title: string } | undefined;

  if (!sonarrShow) {
    // Show not found in Sonarr - clear it
    console.log(`Release ID ${release.id}: "${release.show_name || 'Unknown'}"`);
    console.log(`  ⚠ Sonarr show ${release.sonarr_series_id} not found in sonarr_shows - clearing`);
    db.prepare(`
      UPDATE tv_releases SET
        sonarr_series_id = NULL,
        sonarr_series_title = NULL,
        last_checked_at = datetime('now')
      WHERE id = ?
    `).run(release.id);
    cleared++;
    console.log(`  ✓ Cleared sonarr_series_id\n`);
  } else if (release.tvdb_id && sonarrShow.tvdb_id && release.tvdb_id !== sonarrShow.tvdb_id) {
    // TVDB ID mismatch - clear it
    console.log(`Release ID ${release.id}: "${release.show_name || 'Unknown'}"`);
    console.log(`  ⚠ TVDB ID mismatch: release has ${release.tvdb_id}, Sonarr show has ${sonarrShow.tvdb_id} - clearing`);
    db.prepare(`
      UPDATE tv_releases SET
        sonarr_series_id = NULL,
        sonarr_series_title = NULL,
        last_checked_at = datetime('now')
      WHERE id = ?
    `).run(release.id);
    cleared++;
    console.log(`  ✓ Cleared sonarr_series_id\n`);
  } else {
    // Show exists and TVDB ID matches (or no TVDB ID to compare)
    verified++;
    if (release.show_name) {
      console.log(`Release ID ${release.id}: "${release.show_name}" - ✓ Valid (Sonarr ID ${release.sonarr_series_id}, TVDB ${release.tvdb_id || 'N/A'})\n`);
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`Total releases with sonarr_series_id: ${releasesWithSonarrId.length}`);
console.log(`Cleared (not found or mismatch): ${cleared}`);
console.log(`Verified (valid): ${verified}`);

db.close();
console.log('\n✓ Done');

