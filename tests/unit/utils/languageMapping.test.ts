import { describe, it, expect } from 'vitest';
import {
  getLanguageName,
  getLanguageCode,
  isIndianLanguage,
  MAJOR_INDIAN_LANGUAGES,
  LANGUAGE_NAMES,
} from '../../../src/utils/languageMapping';

describe('Language Mapping Utilities', () => {
  describe('getLanguageName', () => {
    it('should convert ISO code to full name', () => {
      expect(getLanguageName('hi')).toBe('Hindi');
      expect(getLanguageName('ta')).toBe('Tamil');
      expect(getLanguageName('te')).toBe('Telugu');
      expect(getLanguageName('en')).toBe('English');
    });

    it('should handle full names from Radarr', () => {
      expect(getLanguageName('Hindi')).toBe('Hindi');
      expect(getLanguageName('Tamil')).toBe('Tamil');
      expect(getLanguageName('Telugu')).toBe('Telugu');
    });

    it('should handle case-insensitive input', () => {
      expect(getLanguageName('HI')).toBe('Hindi');
      expect(getLanguageName('hindi')).toBe('Hindi');
      expect(getLanguageName('HINDI')).toBe('Hindi');
    });

    it('should handle mixed case input', () => {
      expect(getLanguageName('Hindi')).toBe('Hindi');
      expect(getLanguageName('hindi')).toBe('Hindi');
      expect(getLanguageName('HINDI')).toBe('Hindi');
    });

    it('should return undefined for null or undefined', () => {
      expect(getLanguageName(null)).toBeUndefined();
      expect(getLanguageName(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(getLanguageName('')).toBeUndefined();
    });

    it('should fallback to uppercase for unknown languages', () => {
      expect(getLanguageName('xyz')).toBe('XYZ');
      expect(getLanguageName('unknown')).toBe('UNKNOWN');
    });

    it('should handle all major Indian languages', () => {
      expect(getLanguageName('hi')).toBe('Hindi');
      expect(getLanguageName('bn')).toBe('Bengali');
      expect(getLanguageName('mr')).toBe('Marathi');
      expect(getLanguageName('te')).toBe('Telugu');
      expect(getLanguageName('ta')).toBe('Tamil');
      expect(getLanguageName('gu')).toBe('Gujarati');
      expect(getLanguageName('kn')).toBe('Kannada');
      expect(getLanguageName('ml')).toBe('Malayalam');
      expect(getLanguageName('pa')).toBe('Punjabi');
    });
  });

  describe('getLanguageCode', () => {
    it('should return ISO code for ISO input', () => {
      expect(getLanguageCode('hi')).toBe('hi');
      expect(getLanguageCode('ta')).toBe('ta');
      expect(getLanguageCode('en')).toBe('en');
    });

    it('should convert full name to ISO code', () => {
      expect(getLanguageCode('Hindi')).toBe('hi');
      expect(getLanguageCode('Tamil')).toBe('ta');
      expect(getLanguageCode('Telugu')).toBe('te');
      expect(getLanguageCode('English')).toBe('en');
    });

    it('should handle case-insensitive input', () => {
      expect(getLanguageCode('HINDI')).toBe('hi');
      expect(getLanguageCode('hindi')).toBe('hi');
      expect(getLanguageCode('Hindi')).toBe('hi');
    });

    it('should return undefined for null or undefined', () => {
      expect(getLanguageCode(null)).toBeUndefined();
      expect(getLanguageCode(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(getLanguageCode('')).toBeUndefined();
    });

    it('should handle unknown languages by returning lowercase', () => {
      expect(getLanguageCode('UnknownLanguage')).toBe('unknownlanguage');
    });
  });

  describe('isIndianLanguage', () => {
    it('should return true for major Indian languages (ISO codes)', () => {
      expect(isIndianLanguage('hi')).toBe(true); // Hindi
      expect(isIndianLanguage('ta')).toBe(true); // Tamil
      expect(isIndianLanguage('te')).toBe(true); // Telugu
      expect(isIndianLanguage('bn')).toBe(true); // Bengali
      expect(isIndianLanguage('mr')).toBe(true); // Marathi
      expect(isIndianLanguage('gu')).toBe(true); // Gujarati
      expect(isIndianLanguage('kn')).toBe(true); // Kannada
      expect(isIndianLanguage('ml')).toBe(true); // Malayalam
      expect(isIndianLanguage('pa')).toBe(true); // Punjabi
    });

    it('should return true for major Indian languages (full names)', () => {
      expect(isIndianLanguage('Hindi')).toBe(true);
      expect(isIndianLanguage('Tamil')).toBe(true);
      expect(isIndianLanguage('Telugu')).toBe(true);
      expect(isIndianLanguage('Bengali')).toBe(true);
      expect(isIndianLanguage('Marathi')).toBe(true);
    });

    it('should return false for non-Indian languages', () => {
      expect(isIndianLanguage('en')).toBe(false); // English
      expect(isIndianLanguage('es')).toBe(false); // Spanish
      expect(isIndianLanguage('fr')).toBe(false); // French
      expect(isIndianLanguage('de')).toBe(false); // German
      expect(isIndianLanguage('English')).toBe(false);
      expect(isIndianLanguage('Spanish')).toBe(false);
    });

    it('should handle case-insensitive input', () => {
      expect(isIndianLanguage('HI')).toBe(true);
      expect(isIndianLanguage('hindi')).toBe(true);
      expect(isIndianLanguage('HINDI')).toBe(true);
      expect(isIndianLanguage('Tamil')).toBe(true);
      expect(isIndianLanguage('tamil')).toBe(true);
    });

    it('should return false for null or undefined', () => {
      expect(isIndianLanguage(null)).toBe(false);
      expect(isIndianLanguage(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isIndianLanguage('')).toBe(false);
    });

    it('should return false for unknown languages', () => {
      expect(isIndianLanguage('xyz')).toBe(false);
      expect(isIndianLanguage('UnknownLanguage')).toBe(false);
    });

    it('should correctly identify all major Indian languages', () => {
      // Test all languages in MAJOR_INDIAN_LANGUAGES
      for (const code of MAJOR_INDIAN_LANGUAGES) {
        expect(isIndianLanguage(code)).toBe(true);
        const fullName = LANGUAGE_NAMES[code];
        if (fullName) {
          expect(isIndianLanguage(fullName)).toBe(true);
        }
      }
    });
  });

  describe('Edge cases and bug scenarios', () => {
    it('should handle the bug scenario: Hindi showing warning sign', () => {
      // This was a bug where Hindi was showing a warning sign
      // because isIndianLanguage was not handling full names correctly
      expect(isIndianLanguage('Hindi')).toBe(true);
      expect(getLanguageName('Hindi')).toBe('Hindi');
      expect(getLanguageCode('Hindi')).toBe('hi');
    });

    it('should handle the bug scenario: Tamil showing warning sign', () => {
      // Similar bug for Tamil
      expect(isIndianLanguage('Tamil')).toBe(true);
      expect(getLanguageName('Tamil')).toBe('Tamil');
      expect(getLanguageCode('Tamil')).toBe('ta');
    });

    it('should handle Radarr language format (full names)', () => {
      // Radarr stores languages as full names like "Hindi", "Tamil"
      const radarrLanguages = ['Hindi', 'Tamil', 'Telugu', 'English', 'Spanish'];
      
      radarrLanguages.forEach(lang => {
        const code = getLanguageCode(lang);
        const name = getLanguageName(lang);
        const isIndian = isIndianLanguage(lang);
        
        expect(code).toBeDefined();
        expect(name).toBeDefined();
        expect(typeof isIndian).toBe('boolean');
        
        // Indian languages should be identified correctly
        if (['Hindi', 'Tamil', 'Telugu'].includes(lang)) {
          expect(isIndian).toBe(true);
        } else {
          expect(isIndian).toBe(false);
        }
      });
    });

    it('should handle mixed input formats', () => {
      // Test that functions work regardless of input format
      const testCases = [
        { input: 'hi', expectedName: 'Hindi', expectedCode: 'hi', expectedIndian: true },
        { input: 'Hindi', expectedName: 'Hindi', expectedCode: 'hi', expectedIndian: true },
        { input: 'HINDI', expectedName: 'Hindi', expectedCode: 'hi', expectedIndian: true },
        { input: 'hindi', expectedName: 'Hindi', expectedCode: 'hi', expectedIndian: true },
        { input: 'en', expectedName: 'English', expectedCode: 'en', expectedIndian: false },
        { input: 'English', expectedName: 'English', expectedCode: 'en', expectedIndian: false },
      ];

      testCases.forEach(({ input, expectedName, expectedCode, expectedIndian }) => {
        expect(getLanguageName(input)).toBe(expectedName);
        expect(getLanguageCode(input)).toBe(expectedCode);
        expect(isIndianLanguage(input)).toBe(expectedIndian);
      });
    });
  });
});

