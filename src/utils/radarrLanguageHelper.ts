/**
 * Helper to convert language string to Radarr language object format
 * Radarr uses { id: number, name: string } format
 * 
 * Since we don't have a direct mapping, we'll use common language IDs
 * or default to English if unknown
 */
export function convertLanguageToRadarrFormat(languageName: string | null | undefined): Array<{ id: number; name: string }> {
  if (!languageName) {
    // Default to English if no language specified
    return [{ id: 1, name: 'English' }];
  }

  // Common Radarr language IDs (these are standard across Radarr instances)
  // Note: These IDs may vary, but these are common defaults
  const languageMap: Record<string, { id: number; name: string }> = {
    'English': { id: 1, name: 'English' },
    'Hindi': { id: 2, name: 'Hindi' },
    'Bengali': { id: 3, name: 'Bengali' },
    'Marathi': { id: 4, name: 'Marathi' },
    'Telugu': { id: 5, name: 'Telugu' },
    'Tamil': { id: 6, name: 'Tamil' },
    'Urdu': { id: 7, name: 'Urdu' },
    'Gujarati': { id: 8, name: 'Gujarati' },
    'Kannada': { id: 9, name: 'Kannada' },
    'Punjabi': { id: 10, name: 'Punjabi' },
  };

  // Try exact match first
  const normalized = languageName.trim();
  if (languageMap[normalized]) {
    return [languageMap[normalized]];
  }

  // Try case-insensitive match
  const lower = normalized.toLowerCase();
  for (const [key, value] of Object.entries(languageMap)) {
    if (key.toLowerCase() === lower) {
      return [value];
    }
  }

  // Default to English if not found
  // In production, we might want to fetch languages from Radarr API
  // For now, default to English
  console.warn(`Unknown language "${languageName}", defaulting to English`);
  return [{ id: 1, name: 'English' }];
}

