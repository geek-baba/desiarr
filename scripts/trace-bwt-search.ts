/**
 * Trace the search flow for a specific BWT Movies RSS item
 * This simulates exactly how the system processes "Kona.2025.2160p.ZEE5.WEB-DL.DDP5.1.H.265-DUS"
 */

import { parseRSSItem } from '../src/rss/parseRelease';
import tmdbClient from '../src/tmdb/client';
import { settingsModel } from '../src/models/settings';

// Simulate the RSS item
const rssItem = {
  title: 'Kona.2025.2160p.ZEE5.WEB-DL.DDP5.1.H.265-DUS',
  link: 'https://bwtorrents.tv/details.php?id=70284&hit=1',
  guid: 'test-guid-123',
  description: `Category: Kannada-Movies <br /> Size: 2.4 GB <br /> Status: 4 seeders and 0 leechers <br /> Speed: no traffic <br /> Added: 2025-12-18 18:53:55 <br /> Description: [center] [img]https://img.imageride.net/images/2025/06/07/giphy.gif[/img] [img]https://m.media-amazon.com/images/M/MV5BYmY3OTE3M2UtMjczZC00ZTExLWFiMDQtM2UxOGE3NTUyN2Q5XkEyXkFqcGc@._V1_.jpg[/img]`,
  pubDate: '2025-12-18T18:53:55Z',
};

async function traceSearch() {
console.log('🔍 Tracing BWT Movies RSS Item Search Flow\n');
console.log('='.repeat(80));
console.log(`\n📋 Original RSS Item:`);
console.log(`   Title: "${rssItem.title}"`);
console.log(`   Link: ${rssItem.link}\n`);

// Step 1: Parse RSS Item
console.log('📝 Step 1: Parsing RSS Item');
console.log('-'.repeat(80));
const parsed = parseRSSItem(rssItem, 1, 'BWT');
console.log(`   Parsed clean_title: "${parsed.clean_title}"`);
console.log(`   Parsed normalized_title: "${parsed.normalized_title}"`);
console.log(`   Extracted year: ${parsed.year || 'none'}`);
console.log(`   Extracted TMDB ID: ${parsed.tmdb_id || 'none'}`);
console.log(`   Extracted IMDB ID: ${parsed.imdb_id || 'none'}`);
console.log(`   Resolution: ${parsed.resolution}`);
console.log(`   Source Tag: ${parsed.source_tag}`);
console.log(`   Codec: ${parsed.codec}`);
console.log(`   Audio: ${parsed.audio}\n`);

// Step 2: Check if we have IDs from description
if (parsed.tmdb_id || parsed.imdb_id) {
  console.log('✅ Step 2: Found IDs in RSS description');
  console.log('-'.repeat(80));
  if (parsed.tmdb_id) {
    console.log(`   TMDB ID found: ${parsed.tmdb_id}`);
  }
  if (parsed.imdb_id) {
    console.log(`   IMDB ID found: ${parsed.imdb_id}`);
  }
  console.log('\n');
} else {
  console.log('❌ Step 2: No IDs found in RSS description');
  console.log('-'.repeat(80));
  console.log('   Will proceed to search APIs...\n');
}

// Step 3: Simulate TMDB Search (if no TMDB ID)
if (!parsed.tmdb_id && parsed.clean_title) {
  console.log('🔍 Step 3: TMDB Search');
  console.log('-'.repeat(80));
  
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  
  if (!tmdbApiKey) {
    console.log('   ❌ TMDB API key not configured');
  } else {
    tmdbClient.setApiKey(tmdbApiKey);
    
    console.log(`   Searching TMDB for: "${parsed.clean_title}"`);
    if (parsed.year) {
      console.log(`   With year filter: ${parsed.year}`);
    }
    console.log('');
    
    try {
      // Use searchMovies to get multiple results
      const tmdbResults = await tmdbClient.searchMovies(parsed.clean_title, parsed.year || undefined, 10);
      
      if (tmdbResults && tmdbResults.length > 0) {
        console.log(`   ✅ TMDB returned ${tmdbResults.length} result(s):\n`);
        
        tmdbResults.forEach((movie, index) => {
          const releaseYear = movie.release_date ? new Date(movie.release_date).getFullYear() : 'unknown';
          const yearMatch = parsed.year && releaseYear !== 'unknown' 
            ? (releaseYear === parsed.year ? '✅' : '❌') 
            : '⚠️';
          
          console.log(`   [${index + 1}] ${yearMatch} "${movie.title}"`);
          console.log(`       TMDB ID: ${movie.id}`);
          console.log(`       Release Year: ${releaseYear}`);
          console.log(`       Original Title: ${movie.original_title || 'N/A'}`);
          console.log(`       Original Language: ${movie.original_language || 'N/A'}`);
          console.log(`       Popularity: ${movie.popularity || 'N/A'}`);
          if (movie.overview) {
            console.log(`       Overview: ${movie.overview.substring(0, 100)}...`);
          }
          console.log('');
        });
        
        // Show what the current code would select
        const selectedMovie = tmdbResults[0];
        const releaseYear = selectedMovie.release_date ? new Date(selectedMovie.release_date).getFullYear() : null;
        let isValidMatch = true;
        
        if (parsed.year && releaseYear) {
          if (releaseYear !== parsed.year) {
            isValidMatch = false;
            console.log(`   ⚠️  Current code would REJECT this match (year mismatch: ${releaseYear} vs ${parsed.year})`);
          } else {
            console.log(`   ✅ Current code would ACCEPT this match (year matches: ${releaseYear})`);
          }
        } else {
          console.log(`   ⚠️  Current code would ACCEPT this match (no year validation possible)`);
        }
        
        if (isValidMatch) {
          console.log(`\n   📌 Selected: "${selectedMovie.title}" (TMDB ID: ${selectedMovie.id})`);
          console.log(`   ⚠️  Note: This is the FIRST result, not necessarily the best match!`);
        }
        
      } else {
        console.log('   ❌ TMDB search returned no results');
      }
    } catch (error: any) {
      console.log(`   ❌ TMDB search error: ${error?.message || error}`);
    }
  }
  
  console.log('');
}

// Step 4: Show title similarity (if we have results)
if (!parsed.tmdb_id && parsed.clean_title) {
  console.log('📊 Step 4: Title Similarity Analysis');
  console.log('-'.repeat(80));
  
  const allSettings = settingsModel.getAll();
  const tmdbApiKey = allSettings.find(s => s.key === 'tmdb_api_key')?.value;
  
  if (tmdbApiKey) {
    tmdbClient.setApiKey(tmdbApiKey);
    
    try {
      const tmdbResults = await tmdbClient.searchMovies(parsed.clean_title, parsed.year || undefined, 5);
      
      if (tmdbResults && tmdbResults.length > 0) {
        console.log(`   Comparing "${parsed.clean_title}" with TMDB results:\n`);
        
        // Simple similarity function (Levenshtein-like)
        function simpleSimilarity(str1: string, str2: string): number {
          const s1 = str1.toLowerCase().trim();
          const s2 = str2.toLowerCase().trim();
          
          if (s1 === s2) return 1.0;
          if (s1.includes(s2) || s2.includes(s1)) return 0.8;
          
          // Count common words
          const words1 = s1.split(/\s+/);
          const words2 = s2.split(/\s+/);
          const commonWords = words1.filter(w => words2.includes(w));
          const totalWords = Math.max(words1.length, words2.length);
          
          return commonWords.length / totalWords;
        }
        
        tmdbResults.forEach((movie, index) => {
          const titleSim = simpleSimilarity(parsed.clean_title, movie.title);
          const origTitleSim = movie.original_title 
            ? simpleSimilarity(parsed.clean_title, movie.original_title)
            : 0;
          const maxSim = Math.max(titleSim, origTitleSim);
          
          const simBar = '█'.repeat(Math.floor(maxSim * 20));
          const simPercent = (maxSim * 100).toFixed(1);
          
          console.log(`   [${index + 1}] Similarity: ${simPercent}% ${simBar}`);
          console.log(`       RSS: "${parsed.clean_title}"`);
          console.log(`       TMDB: "${movie.title}"`);
          if (movie.original_title && movie.original_title !== movie.title) {
            console.log(`       Original: "${movie.original_title}"`);
          }
          console.log('');
        });
        
        // Find best match by similarity
        const bestMatch = tmdbResults.map((movie, index) => {
          const titleSim = simpleSimilarity(parsed.clean_title, movie.title);
          const origTitleSim = movie.original_title 
            ? simpleSimilarity(parsed.clean_title, movie.original_title)
            : 0;
          return {
            index,
            movie,
            similarity: Math.max(titleSim, origTitleSim),
          };
        }).sort((a, b) => b.similarity - a.similarity)[0];
        
        console.log(`   🎯 Best match by similarity: [${bestMatch.index + 1}] "${bestMatch.movie.title}" (${(bestMatch.similarity * 100).toFixed(1)}% similar)`);
        if (bestMatch.index !== 0) {
          console.log(`   ⚠️  Current code selects [1] but best match is [${bestMatch.index + 1}]!`);
        }
      }
    } catch (error: any) {
      console.log(`   ❌ Error: ${error?.message || error}`);
    }
  }
  
  console.log('');
}

// Step 5: Summary
console.log('📋 Step 5: Summary');
console.log('='.repeat(80));
console.log(`   Original Title: "${rssItem.title}"`);
console.log(`   Clean Title: "${parsed.clean_title}"`);
console.log(`   Year: ${parsed.year || 'none'}`);
console.log(`   TMDB ID from RSS: ${parsed.tmdb_id || 'none'}`);
console.log(`   IMDB ID from RSS: ${parsed.imdb_id || 'none'}`);
console.log(`\n   Issues Identified:`);
if (!parsed.tmdb_id && !parsed.imdb_id) {
  console.log(`   - No IDs found in RSS description`);
  console.log(`   - Must rely on title-based search (less accurate)`);
}
if (parsed.clean_title) {
  console.log(`   - Title cleaning may have removed important words`);
  console.log(`   - Current code only uses first TMDB result`);
  console.log(`   - No title similarity validation`);
  console.log(`   - Year validation is strict (exact match required)`);
}
console.log('');

}

traceSearch().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

