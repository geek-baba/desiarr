/**
 * Trace TV show matching for a specific RSS item
 * Example: "Kurukshetra The Great War of Mahabharata S01 1080p NF WEB-DL MULTi DD+ 5.1 H.264-DTR"
 * Incorrectly matched to "She (2020)"
 */

import { parseTvTitle } from '../src/services/tvMatchingEngine';
import tvdbClient from '../src/tvdb/client';
import tmdbClient from '../src/tmdb/client';
import { settingsModel } from '../src/models/settings';

async function traceTvMatching() {
const rssTitle = 'Kurukshetra The Great War of Mahabharata S01 1080p NF WEB-DL MULTi DD+ 5.1 H.264-DTR';

console.log('🔍 Tracing TV Show Matching Flow\n');
console.log('='.repeat(80));
console.log(`\n📋 Original RSS Item:`);
console.log(`   Title: "${rssTitle}"\n`);

// Step 1: Parse TV Title
console.log('📝 Step 1: Parsing TV Title');
console.log('-'.repeat(80));
const parsed = parseTvTitle(rssTitle);
console.log(`   Parsed show_name: "${parsed.showName}"`);
console.log(`   Parsed season: ${parsed.season !== null ? parsed.season : 'null'}`);
console.log(`   Parsed year: ${parsed.year || 'null'}\n`);

// Step 2: Check TVDB Search
console.log('🔍 Step 2: TVDB Search');
console.log('-'.repeat(80));

const allSettings = settingsModel.getAll();
const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;

if (!tvdbApiKey) {
  console.log('   ❌ TVDB API key not configured');
} else {
  tvdbClient.updateConfig();
  
  console.log(`   Searching TVDB for: "${parsed.showName}"\n`);
  
  try {
    const tvdbResults = await tvdbClient.searchSeries(parsed.showName);
    
    if (tvdbResults && tvdbResults.length > 0) {
      console.log(`   ✅ TVDB returned ${tvdbResults.length} result(s):\n`);
      
      tvdbResults.slice(0, 10).forEach((series, index) => {
        const tvdbId = (series as any).tvdb_id || (series as any).id || 'N/A';
        const name = (series as any).name || (series as any).title || 'N/A';
        const year = (series as any).year || (series as any).firstAired ? new Date((series as any).firstAired).getFullYear() : 'N/A';
        
        console.log(`   [${index + 1}] "${name}"`);
        console.log(`       TVDB ID: ${tvdbId}`);
        console.log(`       Year: ${year}`);
        console.log('');
      });
      
      // Get extended info for first result
      const firstResult = tvdbResults[0];
      const firstTvdbId = (firstResult as any).tvdb_id || (firstResult as any).id;
      
      if (firstTvdbId) {
        console.log(`   📡 Fetching extended info for TVDB ID: ${firstTvdbId}\n`);
        const tvdbExtended = await tvdbClient.getSeriesExtended(firstTvdbId);
        
        if (tvdbExtended) {
          console.log(`   Series Name: ${(tvdbExtended as any).name || 'N/A'}`);
          console.log(`   Original Language: ${(tvdbExtended as any).originalLanguage || 'N/A'}`);
          
          // Check remoteIds
          const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids;
          if (remoteIds && Array.isArray(remoteIds)) {
            console.log(`\n   Remote IDs (${remoteIds.length}):`);
            remoteIds.forEach((remote: any, idx: number) => {
              console.log(`     [${idx + 1}] Source: ${remote.sourceName || remote.source_name || remote.source || 'N/A'}, ID: ${remote.id || 'N/A'}`);
            });
            
            const tmdbRemote = remoteIds.find((r: any) => 
              r.sourceName === 'TheMovieDB.com' || 
              r.sourceName === 'TheMovieDB' || 
              r.source_name === 'TheMovieDB.com' || 
              r.source_name === 'TheMovieDB' ||
              r.source === 'themoviedb'
            );
            
            if (tmdbRemote) {
              console.log(`\n   ✅ Found TMDB ID from TVDB: ${tmdbRemote.id}`);
            } else {
              console.log(`\n   ❌ No TMDB ID found in TVDB remoteIds`);
            }
          } else {
            console.log(`\n   ❌ No remoteIds found in TVDB extended info`);
          }
        }
      }
    } else {
      console.log('   ❌ TVDB search returned no results');
    }
  } catch (error: any) {
    console.log(`   ❌ TVDB search error: ${error?.message || error}`);
  }
}

// Step 3: Check TMDB Search (if TVDB doesn't have TMDB ID)
console.log('\n\n🔍 Step 3: TMDB Search (Fallback)');
console.log('-'.repeat(80));

if (tmdbApiKey) {
  tmdbClient.setApiKey(tmdbApiKey);
  
  console.log(`   Searching TMDB for: "${parsed.showName}"\n`);
  
  try {
    const tmdbResults = await tmdbClient.searchTv(parsed.showName);
    
    if (tmdbResults && tmdbResults.length > 0) {
      console.log(`   ✅ TMDB returned ${tmdbResults.length} result(s):\n`);
      
      tmdbResults.slice(0, 10).forEach((show, index) => {
        const name = show.name || 'N/A';
        const originalName = show.original_name || 'N/A';
        const firstAirDate = show.first_air_date ? new Date(show.first_air_date).getFullYear() : 'N/A';
        const language = show.original_language || 'N/A';
        
        console.log(`   [${index + 1}] "${name}"`);
        console.log(`       TMDB ID: ${show.id}`);
        console.log(`       Original Name: ${originalName}`);
        console.log(`       First Air Date: ${firstAirDate}`);
        console.log(`       Language: ${language}`);
        console.log('');
      });
      
      // Check if "She (2020)" is in results
      const sheMatch = tmdbResults.find((show: any) => 
        show.name?.toLowerCase().includes('she') || 
        show.original_name?.toLowerCase().includes('she')
      );
      
      if (sheMatch) {
        const sheIndex = tmdbResults.indexOf(sheMatch) + 1;
        console.log(`\n   ⚠️  Found "She" at position [${sheIndex}] in TMDB results`);
        console.log(`       This might be incorrectly selected if it's the first result!`);
      }
    } else {
      console.log('   ❌ TMDB search returned no results');
    }
  } catch (error: any) {
    console.log(`   ❌ TMDB search error: ${error?.message || error}`);
  }
}

// Step 4: Analyze the matching logic
console.log('\n\n📊 Step 4: Matching Logic Analysis');
console.log('='.repeat(80));
console.log(`\n   Parsed Show Name: "${parsed.showName}"`);
console.log(`   Expected Match: Something related to "Kurukshetra" or "Mahabharata"`);
console.log(`   Actual Match: "She (2020)"`);
console.log(`\n   Issues to investigate:`);
console.log(`   1. Is the show name parsed correctly?`);
console.log(`   2. What does TVDB return for this search?`);
console.log(`   3. What does TMDB return for this search?`);
console.log(`   4. Why would "She" be selected over "Kurukshetra"?`);
console.log(`   5. Is there a language mismatch issue?`);
console.log('');

}

traceTvMatching().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

