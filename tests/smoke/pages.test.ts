import { describe, it, expect } from 'vitest';

/**
 * Smoke tests for page loading
 * These tests verify that utility modules can be imported without syntax errors
 * They don't test functionality, just that the code doesn't break
 * 
 * Note: We skip route handlers and services that require database initialization
 */

describe('Page Smoke Tests', () => {
  describe('Utility modules', () => {
    it('should import language mapping utilities without errors', async () => {
      const langModule = await import('../../src/utils/languageMapping');
      expect(langModule).toBeDefined();
      expect(langModule.getLanguageName).toBeDefined();
      expect(langModule.getLanguageCode).toBeDefined();
      expect(langModule.isIndianLanguage).toBeDefined();
    });

    it('should import title parsing utilities without errors', async () => {
      const parseModule = await import('../../src/scoring/parseFromTitle');
      expect(parseModule).toBeDefined();
      expect(parseModule.parseReleaseFromTitle).toBeDefined();
    });
  });

  describe('API clients (no DB required)', () => {
    it('should import TMDB client without errors', async () => {
      const tmdbModule = await import('../../src/tmdb/client');
      expect(tmdbModule).toBeDefined();
      expect(tmdbModule.TMDBClient).toBeDefined();
    });
  });

  // Note: Route handlers and services that require DB initialization are tested
  // through integration tests or manual testing, not smoke tests
});

