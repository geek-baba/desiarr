/**
 * Test TMDB search to see actual result order
 */

import tmdbClient from '../src/tmdb/client';
import { settingsModel } from '../src/models/settings';

async function testSearch() {
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  
  if (!tmdbApiKey) {
    console.error('TMDB API key not configured');
    process.exit(1);
  }
  
  tmdbClient.setApiKey(tmdbApiKey);
  
  console.log('🔍 Testing TMDB search for "Kona" with year 2025\n');
  console.log('='.repeat(80));
  
  // Test searchMovie (what the code actually uses)
  console.log('\n📋 Using searchMovie() (single result):');
  console.log('-'.repeat(80));
  const singleResult = await tmdbClient.searchMovie('Kona', 2025);
  if (singleResult) {
    console.log(`   Selected: "${singleResult.title}" (ID: ${singleResult.id})`);
    console.log(`   Year: ${singleResult.release_date ? new Date(singleResult.release_date).getFullYear() : 'unknown'}`);
    console.log(`   Language: ${singleResult.original_language || 'unknown'}`);
    console.log(`   Original Title: ${singleResult.original_title || 'N/A'}`);
  } else {
    console.log('   No result');
  }
  
  // Test searchMovies (multiple results)
  console.log('\n📋 Using searchMovies() (multiple results - actual API order):');
  console.log('-'.repeat(80));
  const allResults = await tmdbClient.searchMovies('Kona', 2025, 10);
  
  if (allResults && allResults.length > 0) {
    console.log(`   TMDB returned ${allResults.length} results in this order:\n`);
    
    allResults.forEach((movie, index) => {
      const releaseYear = movie.release_date ? new Date(movie.release_date).getFullYear() : 'unknown';
      const yearMatches = releaseYear === 2025;
      const marker = yearMatches ? '✅' : '❌';
      
      console.log(`   [${index + 1}] ${marker} "${movie.title}"`);
      console.log(`       ID: ${movie.id}`);
      console.log(`       Year: ${releaseYear}`);
      console.log(`       Language: ${movie.original_language || 'unknown'}`);
      console.log(`       Original Title: ${movie.original_title || 'N/A'}`);
      console.log(`       Popularity: ${movie.popularity || 'N/A'}`);
      console.log('');
    });
    
    // Show what find() would return (first with year 2025)
    const firstYearMatch = allResults.find(movie => {
      if (movie.release_date) {
        const releaseYear = new Date(movie.release_date).getFullYear();
        return releaseYear === 2025;
      }
      return false;
    });
    
    if (firstYearMatch) {
      const matchIndex = allResults.indexOf(firstYearMatch) + 1;
      console.log(`\n   🎯 searchMovie() would return: [${matchIndex}] "${firstYearMatch.title}"`);
      console.log(`       (First result in array with year 2025)`);
      
      if (matchIndex !== 1) {
        console.log(`\n   ⚠️  PROBLEM: This is NOT the first result!`);
        console.log(`       TMDB returned results in a different order.`);
        console.log(`       The code uses find() which returns the FIRST match in the array,`);
        console.log(`       not necessarily the best match by title similarity.`);
      }
    }
  } else {
    console.log('   No results');
  }
  
  console.log('\n' + '='.repeat(80));
}

testSearch().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


