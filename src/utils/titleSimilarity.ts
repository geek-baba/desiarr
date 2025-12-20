/**
 * Title similarity utilities for matching RSS items to TMDB movies
 */

/**
 * Calculate similarity score between two strings (0-1)
 * Uses a combination of exact match, contains match, and word overlap
 */
export function calculateTitleSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // One contains the other (high similarity)
  if (s1.includes(s2) || s2.includes(s1)) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    return 0.7 + (shorter.length / longer.length) * 0.2; // 0.7-0.9 range
  }
  
  // Word-based similarity
  const words1 = s1.split(/\s+/).filter(w => w.length > 0);
  const words2 = s2.split(/\s+/).filter(w => w.length > 0);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Count common words
  const commonWords = words1.filter(w => words2.includes(w));
  const totalUniqueWords = new Set([...words1, ...words2]).size;
  
  // Jaccard similarity (intersection over union)
  const jaccard = commonWords.length / totalUniqueWords;
  
  // Also check if all words from shorter title are in longer title
  const shorterWords = words1.length <= words2.length ? words1 : words2;
  const longerWords = words1.length > words2.length ? words1 : words2;
  const allWordsMatch = shorterWords.every(w => longerWords.includes(w));
  
  if (allWordsMatch) {
    return Math.max(jaccard, 0.6); // Boost if all words match
  }
  
  return jaccard;
}

/**
 * Validate that a matched show name contains key words from the parsed show name
 * This helps prevent false matches like "Azad" matching "Le Mille E Una Notte"
 */
export function validateShowNameMatch(parsedName: string, matchedName: string, minWordMatch: number = 1): boolean {
  const parsedWords = parsedName.toLowerCase().trim().split(/\s+/).filter(w => w.length > 2); // Filter out short words like "a", "the", "of"
  const matchedLower = matchedName.toLowerCase().trim();
  
  if (parsedWords.length === 0) return true; // If no meaningful words, accept match
  
  // Count how many key words from parsed name appear in matched name
  const matchedWords = parsedWords.filter(word => matchedLower.includes(word));
  
  // Require at least minWordMatch words to be present, or if parsed name is very short (1-2 words), require all
  if (parsedWords.length <= 2) {
    return matchedWords.length === parsedWords.length;
  }
  
  return matchedWords.length >= minWordMatch;
}

/**
 * Check if year information is consistent
 * Returns true if years match (within tolerance), false if mismatch is significant
 */
export function validateYearMatch(parsedYear: number | null, matchedYear: string | number | null, tolerance: number = 3): boolean {
  if (!parsedYear || !matchedYear) return true; // If either is missing, don't reject
  
  const matchedYearNum = typeof matchedYear === 'string' ? parseInt(matchedYear, 10) : matchedYear;
  if (isNaN(matchedYearNum)) return true; // If can't parse, don't reject
  
  const yearDiff = Math.abs(parsedYear - matchedYearNum);
  return yearDiff <= tolerance;
}

/**
 * Get language code from RSS item
 * Checks audio_languages field and description for language hints
 */
export function getLanguageFromRssItem(item: { audio_languages?: string | null; title?: string; description?: string }): string | null {
  // Try audio_languages first (from title parsing)
  if (item.audio_languages) {
    try {
      const languages = JSON.parse(item.audio_languages);
      if (Array.isArray(languages) && languages.length > 0) {
        // Return first language code
        return languages[0];
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  // Try to extract from description (BWT format: "Category: Kannada-Movies")
  if (item.description) {
    const categoryMatch = item.description.match(/Category:\s*([^-]+)-Movies/i);
    if (categoryMatch) {
      const category = categoryMatch[1].trim().toLowerCase();
      // Map category names to language codes
      const categoryMap: Record<string, string> = {
        'kannada': 'kn',
        'telugu': 'te',
        'tamil': 'ta',
        'malayalam': 'ml',
        'hindi': 'hi',
        'english': 'en',
        'bengali': 'bn',
        'marathi': 'mr',
        'gujarati': 'gu',
        'punjabi': 'pa',
      };
      return categoryMap[category] || null;
    }
  }
  
  return null;
}

/**
 * Score a TMDB movie match based on title similarity and language
 */
export function scoreTmdbMatch(
  queryTitle: string,
  tmdbMovie: { title: string; original_title?: string; original_language?: string },
  expectedLanguage?: string | null
): number {
  let score = 0;
  
  // Title similarity (0-0.7 weight)
  const titleSim = calculateTitleSimilarity(queryTitle, tmdbMovie.title);
  score += titleSim * 0.7;
  
  // Original title similarity (0-0.2 weight, only if different from title)
  if (tmdbMovie.original_title && tmdbMovie.original_title !== tmdbMovie.title) {
    const origTitleSim = calculateTitleSimilarity(queryTitle, tmdbMovie.original_title);
    score += origTitleSim * 0.2;
  }
  
  // Language match bonus (0-0.1 weight)
  if (expectedLanguage && tmdbMovie.original_language) {
    if (expectedLanguage.toLowerCase() === tmdbMovie.original_language.toLowerCase()) {
      score += 0.1; // Bonus for language match
    }
  }
  
  return Math.min(score, 1.0);
}

