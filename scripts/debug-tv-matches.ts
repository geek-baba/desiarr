/**
 * Debug TV show matching issues
 */

import db from '../src/db';

interface TvRelease {
  id: number;
  title: string;
  show_name: string;
  tvdb_id: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  sonarr_series_title: string | null;
  status: string;
}

interface RssItem {
  id: number;
  title: string;
  tvdb_id: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  tvdb_id_manual: number | null;
  tmdb_id_manual: number | null;
}

function debugShow(searchTerm: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`DEBUGGING: ${searchTerm}`);
  console.log('='.repeat(80));
  
  // Find TV releases
  const releases = db.prepare(`
    SELECT id, title, show_name, tvdb_id, tmdb_id, imdb_id, sonarr_series_title, status
    FROM tv_releases
    WHERE title LIKE ? OR show_name LIKE ? OR sonarr_series_title LIKE ?
    ORDER BY id DESC
    LIMIT 10
  `).all(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`) as TvRelease[];
  
  console.log(`\n📺 TV RELEASES (${releases.length} found):`);
  for (const release of releases) {
    console.log(`\n  Release ID: ${release.id}`);
    console.log(`  Title: ${release.title}`);
    console.log(`  Show Name: ${release.show_name}`);
    console.log(`  TVDB ID: ${release.tvdb_id || 'NULL'}`);
    console.log(`  TMDB ID: ${release.tmdb_id || 'NULL'}`);
    console.log(`  IMDB ID: ${release.imdb_id || 'NULL'}`);
    console.log(`  Sonarr Title: ${release.sonarr_series_title || 'NULL'}`);
    console.log(`  Status: ${release.status}`);
  }
  
  // Find RSS items
  const rssItems = db.prepare(`
    SELECT id, title, tvdb_id, tmdb_id, imdb_id, tvdb_id_manual, tmdb_id_manual
    FROM rss_feed_items
    WHERE title LIKE ?
    ORDER BY id DESC
    LIMIT 10
  `).all(`%${searchTerm}%`) as RssItem[];
  
  console.log(`\n📡 RSS FEED ITEMS (${rssItems.length} found):`);
  for (const item of rssItems) {
    console.log(`\n  RSS Item ID: ${item.id}`);
    console.log(`  Title: ${item.title}`);
    console.log(`  TVDB ID: ${item.tvdb_id || 'NULL'} ${item.tvdb_id_manual ? '(MANUAL)' : ''}`);
    console.log(`  TMDB ID: ${item.tmdb_id || 'NULL'} ${item.tmdb_id_manual ? '(MANUAL)' : ''}`);
    console.log(`  IMDB ID: ${item.imdb_id || 'NULL'}`);
  }
}

// Debug the shows from the screenshots
debugShow('Mille');
debugShow('Aladino');
debugShow('Sherazade');
debugShow('Azad');
debugShow('Fall');
debugShow('Rise');
debugShow('Scam');
debugShow('Class');
debugShow('90');

process.exit(0);

