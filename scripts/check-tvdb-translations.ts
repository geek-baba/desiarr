/**
 * Check TVDB extended response for translations/aliases
 */

import tvdbClient from '../src/tvdb/client';
import { settingsModel } from '../src/models/settings';

async function checkTvdbTranslations() {
  const allSettings = settingsModel.getAll();
  const tvdbApiKey = allSettings.find(s => s.key === 'tvdb_api_key')?.value;
  
  if (!tvdbApiKey) {
    console.log('TVDB API key not configured');
    process.exit(1);
  }
  
  tvdbClient.updateConfig();
  
  // Check Kurukshetra (468042)
  console.log('Checking TVDB ID 468042 (Kurukshetra)...\n');
  
  const extended = await tvdbClient.getSeriesExtended(468042);
  
  if (extended) {
    console.log('TVDB Extended Response Structure:');
    console.log(JSON.stringify(extended, null, 2));
    
    // Check for translations
    if ((extended as any).translations) {
      console.log('\nFound translations:', (extended as any).translations);
    }
    if ((extended as any).aliases) {
      console.log('\nFound aliases:', (extended as any).aliases);
    }
    if ((extended as any).nameTranslations) {
      console.log('\nFound nameTranslations:', (extended as any).nameTranslations);
    }
  }
  
  process.exit(0);
}

checkTvdbTranslations().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});


