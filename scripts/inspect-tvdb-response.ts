/**
 * Diagnostic script to inspect TVDB API response structure
 * This will fetch a TVDB series extended info and log the structure
 * to help understand how remoteIds are formatted
 */

import db from '../src/db';
import tvdbClient from '../src/tvdb/client';
import { settingsModel } from '../src/models/settings';

async function inspectTvdbResponse() {
  console.log('🔍 TVDB Response Structure Inspector\n');

  // Get TVDB API key
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  
  if (!tvdbApiKey) {
    console.error('❌ TVDB API key not configured');
    process.exit(1);
  }

  // Get a sample TVDB ID from the database
  const sampleRelease = db.prepare(`
    SELECT tvdb_id, show_name, title
    FROM tv_releases
    WHERE tvdb_id IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get() as { tvdb_id: number; show_name: string; title: string } | undefined;

  if (!sampleRelease) {
    console.error('❌ No TV releases with TVDB ID found in database');
    process.exit(1);
  }

  const tvdbId = sampleRelease.tvdb_id;
  console.log(`📺 Using sample show: "${sampleRelease.show_name}"`);
  console.log(`   Title: ${sampleRelease.title}`);
  console.log(`   TVDB ID: ${tvdbId}\n`);

  try {
    console.log('📡 Fetching TVDB extended info...\n');
    const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
    
    if (!tvdbExtended) {
      console.error('❌ Failed to fetch TVDB extended info');
      process.exit(1);
    }

    console.log('✅ TVDB Extended Response Structure:\n');
    console.log('=' .repeat(80));
    
    // Log top-level keys
    console.log('\n📋 Top-level keys:');
    console.log(JSON.stringify(Object.keys(tvdbExtended), null, 2));
    
    // Log remoteIds structure specifically
    console.log('\n🔗 remoteIds structure:');
    const remoteIds = (tvdbExtended as any).remoteIds || (tvdbExtended as any).remote_ids;
    
    if (remoteIds) {
      console.log(`   Type: ${Array.isArray(remoteIds) ? 'Array' : typeof remoteIds}`);
      console.log(`   Length: ${Array.isArray(remoteIds) ? remoteIds.length : 'N/A'}`);
      
      if (Array.isArray(remoteIds) && remoteIds.length > 0) {
        console.log('\n   Sample remoteId entries:');
        remoteIds.slice(0, 5).forEach((remote: any, index: number) => {
          console.log(`\n   [${index}]:`);
          console.log(`      Keys: ${JSON.stringify(Object.keys(remote))}`);
          console.log(`      Full object: ${JSON.stringify(remote, null, 6)}`);
        });
        
        // Check for TMDB specifically
        console.log('\n   🔍 Searching for TMDB entries:');
        const tmdbMatches = remoteIds.filter((r: any) => {
          const source = r.source || r.sourceName || r.source_name || '';
          const sourceLower = String(source).toLowerCase();
          return sourceLower.includes('tmdb') || 
                 sourceLower.includes('themoviedb') || 
                 sourceLower.includes('movie');
        });
        
        if (tmdbMatches.length > 0) {
          console.log(`   ✅ Found ${tmdbMatches.length} potential TMDB entry(ies):`);
          tmdbMatches.forEach((match: any, index: number) => {
            console.log(`\n   [${index}]:`);
            console.log(`      Full object: ${JSON.stringify(match, null, 6)}`);
          });
        } else {
          console.log('   ❌ No TMDB entries found');
        }
        
        // Check for IMDB specifically
        console.log('\n   🔍 Searching for IMDB entries:');
        const imdbMatches = remoteIds.filter((r: any) => {
          const source = r.source || r.sourceName || r.source_name || '';
          const sourceLower = String(source).toLowerCase();
          return sourceLower.includes('imdb');
        });
        
        if (imdbMatches.length > 0) {
          console.log(`   ✅ Found ${imdbMatches.length} potential IMDB entry(ies):`);
          imdbMatches.forEach((match: any, index: number) => {
            console.log(`\n   [${index}]:`);
            console.log(`      Full object: ${JSON.stringify(match, null, 6)}`);
          });
        } else {
          console.log('   ❌ No IMDB entries found');
        }
      } else {
        console.log('   ⚠️  remoteIds is empty or not an array');
      }
    } else {
      console.log('   ❌ remoteIds not found in response');
      console.log('   Available keys:', JSON.stringify(Object.keys(tvdbExtended), null, 2));
    }
    
    // Also log the full response (truncated) for reference
    console.log('\n\n📄 Full response (first 2000 chars):');
    const fullResponse = JSON.stringify(tvdbExtended, null, 2);
    console.log(fullResponse.substring(0, 2000));
    if (fullResponse.length > 2000) {
      console.log(`\n... (truncated, total length: ${fullResponse.length} chars)`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('\n✅ Inspection complete');
    
  } catch (error: any) {
    console.error('❌ Error:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
  
  process.exit(0);
}

inspectTvdbResponse();


