import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import dashboardRouter from '../../src/routes/dashboard';
import settingsRouter from '../../src/routes/settings';
import dataRouter from '../../src/routes/data';
import logsRouter from '../../src/routes/logs';

/**
 * Smoke tests for all pages
 * These tests verify that all EJS templates render without errors
 * They use mocked database/models to avoid requiring a real database
 */

// Mock database and models before importing anything that uses them
vi.mock('../../src/db', () => {
  const mockDb = {
    prepare: vi.fn((query: string) => {
      // For count queries (used by sync services), return { count: 0 }
      if (query.includes('COUNT') || query.includes('count')) {
        return {
          get: vi.fn(() => ({ count: 0 })),
          all: vi.fn(() => []),
          run: vi.fn(() => ({ changes: 0, lastInsertRowid: 1 })),
        };
      }
      // For other queries (like app_settings), return undefined (no result)
      return {
        get: vi.fn(() => undefined),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 0, lastInsertRowid: 1 })),
      };
    }),
    exec: vi.fn(),
  };
  return {
    default: mockDb,
  };
});

// Mock models to return minimal data
vi.mock('../../src/models/settings', () => ({
  settingsModel: {
    getAll: vi.fn(() => []),
    get: vi.fn(() => null),
    getQualitySettings: vi.fn(() => ({
      resolutions: [],
      resolutionWeights: {},
      sourceTagWeights: {},
      codecWeights: {},
      audioWeights: {},
      preferredAudioLanguages: [],
      preferredLanguageBonus: 0,
      dubbedPenalty: 0,
      sizeBonusEnabled: false,
      minSizeIncreasePercentForUpgrade: 10,
      upgradeThreshold: 5,
      sizeOnlyUpgradePercent: 25,
    })),
    getAppSettings: vi.fn(() => ({
      pollIntervalMinutes: 0,
      radarrSyncIntervalHours: 6,
      sonarrSyncIntervalHours: 6,
      rssSyncIntervalHours: 1,
    })),
  },
}));

vi.mock('../../src/models/feeds', () => ({
  feedsModel: {
    getAll: vi.fn(() => []),
    getEnabled: vi.fn(() => []),
  },
}));

vi.mock('../../src/models/releases', () => ({
  movieReleasesModel: {
    getAll: vi.fn(() => []),
    getByStatus: vi.fn(() => []),
  },
  releasesModel: {
    getAll: vi.fn(() => []),
    getByStatus: vi.fn(() => []),
  },
}));

vi.mock('../../src/models/tvReleases', () => ({
  tvReleasesModel: {
    getAll: vi.fn(() => []),
    getByStatus: vi.fn(() => []),
  },
}));

vi.mock('../../src/services/logStorage', () => ({
  default: {
    getLogs: vi.fn(() => []),
    getLogsByFilter: vi.fn(() => []),
    getCount: vi.fn(() => 0),
  },
}));

// Mock axios for GitHub API calls and TMDB client
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  const mockAxiosInstance = {
    get: vi.fn(() => Promise.reject(new Error('Mock: API call not expected in smoke tests'))),
    post: vi.fn(() => Promise.reject(new Error('Mock: API call not expected in smoke tests'))),
    put: vi.fn(() => Promise.reject(new Error('Mock: API call not expected in smoke tests'))),
    delete: vi.fn(() => Promise.reject(new Error('Mock: API call not expected in smoke tests'))),
  };
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(() => mockAxiosInstance),
      get: vi.fn(() => Promise.reject(new Error('Mock: API call not expected in smoke tests'))),
    },
  };
});

function createTestApp() {
  const app = express();

  // Expose app version to all views
  let appVersion = '2.1.0';
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonRaw);
    if (typeof packageJson.version === 'string') {
      appVersion = packageJson.version;
    }
  } catch (error) {
    // Use default
  }
  app.locals.appVersion = appVersion;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../../views'));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Make appVersion available to all templates via res.locals
  app.use((req, res, next) => {
    res.locals.appVersion = app.locals.appVersion;
    next();
  });

  // Mount routers
  app.use('/', dashboardRouter);
  app.use('/settings', settingsRouter);
  app.use('/data', dataRouter);
  app.use('/api/logs', logsRouter);

  // Error handler for tests
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Test app error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  });

  return app;
}

describe('Page Smoke Tests - Template Rendering', () => {
  let app: express.Application;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('Dashboard pages', () => {
    it('should render combined dashboard without errors', async () => {
      const response = await request(app)
        .get('/dashboard')
        .expect(200);
      
      expect(response.text).toContain('desiarr');
      expect(response.text).toContain('Dashboard');
    });

    it('should render movies dashboard without errors', async () => {
      const response = await request(app)
        .get('/movies')
        .expect(200);
      
      expect(response.text).toContain('desiarr');
      expect(response.text).toContain('Movies');
    });

    it('should render TV dashboard without errors', async () => {
      const response = await request(app)
        .get('/tv')
        .expect(200);
      
      expect(response.text).toContain('desiarr');
      expect(response.text).toContain('TV Shows');
    });
  });

  describe('Settings page', () => {
    it('should render settings page without errors', async () => {
      const response = await request(app)
        .get('/settings')
        .expect(200);
      
      expect(response.text).toContain('Settings');
      expect(response.text).toContain('RSS Feeds');
      expect(response.text).toContain('Connections');
      expect(response.text).toContain('App Settings');
      expect(response.text).toContain('Quality Settings');
      expect(response.text).toContain('About');
    });
  });

  describe('Data pages', () => {
    it('should render movie releases list without errors', async () => {
      const response = await request(app)
        .get('/data/releases')
        .expect(200);
      
      expect(response.text).toContain('Movie Releases');
    });

    it('should render TV releases list without errors', async () => {
      const response = await request(app)
        .get('/data/tv-releases')
        .expect(200);
      
      expect(response.text).toContain('TV Releases');
    });

    it('should render Radarr data page without errors', async () => {
      const response = await request(app)
        .get('/data/radarr')
        .expect(200);
      
      expect(response.text).toContain('Radarr Data');
    });

    it('should render Sonarr data page without errors', async () => {
      const response = await request(app)
        .get('/data/sonarr')
        .expect(200);
      
      expect(response.text).toContain('Sonarr Data');
    });

    it('should render RSS data page without errors', async () => {
      const response = await request(app)
        .get('/data/rss')
        .expect(200);
      
      expect(response.text).toContain('RSS Data');
    });

    it('should render log explorer page without errors', async () => {
      const response = await request(app)
        .get('/data/logs')
        .expect(200);
      
      expect(response.text).toContain('Log');
    });
  });

  describe('Logs pages', () => {
    it('should render logs page without errors', async () => {
      const response = await request(app)
        .get('/api/logs')
        .expect(200);
      
      // Logs page should render (might be JSON or HTML depending on route)
      expect(response.status).toBe(200);
    });
  });

  describe('Template includes', () => {
    it('should render app-sidebar partial without errors', async () => {
      const response = await request(app)
        .get('/settings')
        .expect(200);
      
      // Check that sidebar is rendered (contains navigation items)
      expect(response.text).toContain('Dashboard');
      expect(response.text).toContain('Settings');
      // Check that version is rendered correctly
      expect(response.text).toMatch(/v\d+\.\d+\.\d+/);
    });

    it('should render app-header partial without errors', async () => {
      const response = await request(app)
        .get('/dashboard')
        .expect(200);
      
      // Header should be present (check for common header elements)
      expect(response.text).toContain('desiarr');
    });
  });

  describe('Error handling', () => {
    it('should handle missing routes gracefully', async () => {
      const response = await request(app)
        .get('/nonexistent-page')
        .expect(404);
      
      // Should not crash, should return 404
      expect(response.status).toBe(404);
    });
  });
});
