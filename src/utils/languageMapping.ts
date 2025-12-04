/**
 * Language mapping utilities for converting between ISO codes and full names,
 * and identifying major Indian languages.
 */

// Major Indian languages (ISO 639-1 codes)
export const MAJOR_INDIAN_LANGUAGES = new Set(['hi', 'bn', 'mr', 'te', 'ta', 'ur', 'gu', 'kn', 'ml', 'pa']);

// ISO 639-1 (2-letter) and ISO 639-2 (3-letter) to full language name mapping
// MediaInfo uses ISO 639-2 codes (e.g., "pan" for Punjabi)
export const LANGUAGE_NAMES: Record<string, string> = {
  // ISO 639-1 codes (2-letter)
  'hi': 'Hindi',
  'bn': 'Bengali',
  'mr': 'Marathi',
  'te': 'Telugu',
  'ta': 'Tamil',
  'ur': 'Urdu',
  'gu': 'Gujarati',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'pa': 'Punjabi',
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese',
  'ar': 'Arabic',
  // ISO 639-2 codes (3-letter) - MediaInfo uses these
  'pan': 'Punjabi', // ISO 639-2 code for Punjabi (MediaInfo standard)
  'hin': 'Hindi',
  'ben': 'Bengali',
  'mar': 'Marathi',
  'tel': 'Telugu',
  'tam': 'Tamil',
  'urd': 'Urdu',
  'guj': 'Gujarati',
  'kan': 'Kannada',
  'mal': 'Malayalam',
  'eng': 'English',
  'spa': 'Spanish',
  'fra': 'French',
  'deu': 'German',
  'ita': 'Italian',
  'por': 'Portuguese',
  'rus': 'Russian',
  'jpn': 'Japanese',
  'kor': 'Korean',
  'zho': 'Chinese',
  'ara': 'Arabic',
};

// Full language name to ISO code mapping (for Radarr which stores full names)
export const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  'Hindi': 'hi',
  'Bengali': 'bn',
  'Marathi': 'mr',
  'Telugu': 'te',
  'Tamil': 'ta',
  'Urdu': 'ur',
  'Gujarati': 'gu',
  'Kannada': 'kn',
  'Malayalam': 'ml',
  'Punjabi': 'pa',
  'English': 'en',
  'Spanish': 'es',
  'French': 'fr',
  'German': 'de',
  'Italian': 'it',
  'Portuguese': 'pt',
  'Russian': 'ru',
  'Japanese': 'ja',
  'Korean': 'ko',
  'Chinese': 'zh',
  'Arabic': 'ar',
};

/**
 * Get full language name from ISO code or full name
 * @param code - ISO code (e.g., 'hi') or full name (e.g., 'Hindi')
 * @returns Full language name (e.g., 'Hindi') or undefined if not found
 */
export function getLanguageName(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const lowerCode = code.toLowerCase();
  if (LANGUAGE_NAMES[lowerCode]) {
    return LANGUAGE_NAMES[lowerCode];
  }
  const capitalized = code.charAt(0).toUpperCase() + code.slice(1).toLowerCase();
  if (LANGUAGE_NAME_TO_CODE[capitalized]) {
    return capitalized;
  }
  return code.toUpperCase(); // Fallback to uppercase original if no mapping
}

/**
 * Get ISO code from language (handles both ISO codes and full names)
 * @param language - ISO code (e.g., 'hi') or full name (e.g., 'Hindi')
 * @returns ISO code (e.g., 'hi') or undefined if not found
 */
export function getLanguageCode(language: string | null | undefined): string | undefined {
  if (!language) return undefined;
  const lowerLang = language.toLowerCase();
  if (MAJOR_INDIAN_LANGUAGES.has(lowerLang) || LANGUAGE_NAMES[lowerLang]) {
    return lowerLang;
  }
  const capitalized = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();
  return LANGUAGE_NAME_TO_CODE[capitalized] || lowerLang;
}

/**
 * Check if a language is a major Indian language
 * @param code - ISO code (e.g., 'hi') or full name (e.g., 'Hindi')
 * @returns true if the language is a major Indian language
 */
export function isIndianLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  const isoCode = getLanguageCode(code);
  return isoCode ? MAJOR_INDIAN_LANGUAGES.has(isoCode) : false;
}

