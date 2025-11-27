import axios, { AxiosInstance } from 'axios';
import { settingsModel } from '../models/settings';

class SonarrClient {
  private client: AxiosInstance | null = null;

  constructor() {
    this.initializeClient();
  }

  private initializeClient() {
    const allSettings = settingsModel.getAll();
    const sonarrApiUrl = allSettings.find((s) => s.key === 'sonarr_api_url')?.value;
    const sonarrApiKey = allSettings.find((s) => s.key === 'sonarr_api_key')?.value;

    console.log(
      'Sonarr client initialization - URL:',
      sonarrApiUrl ? 'Set' : 'Not set',
      'Key:',
      sonarrApiKey ? 'Set' : 'Not set'
    );

    if (sonarrApiUrl && sonarrApiKey) {
      this.client = axios.create({
        baseURL: sonarrApiUrl,
        headers: {
          'X-Api-Key': sonarrApiKey,
        },
        timeout: 30000,
      });
      console.log('Sonarr client initialized with URL:', sonarrApiUrl);
    } else {
      this.client = null;
      console.log('Sonarr client NOT initialized - missing URL or Key');
    }
  }

  updateConfig() {
    this.initializeClient();
  }

  private ensureClient(): AxiosInstance {
    this.initializeClient();

    if (!this.client) {
      const allSettings = settingsModel.getAll();
      const sonarrApiUrl = allSettings.find((s) => s.key === 'sonarr_api_url')?.value;
      const sonarrApiKey = allSettings.find((s) => s.key === 'sonarr_api_key')?.value;

      if (!sonarrApiUrl || !sonarrApiKey) {
        throw new Error('Sonarr API not configured. Please configure Sonarr API URL and Key in Settings page.');
      }

      throw new Error('Sonarr client initialization failed. Please check your Sonarr API URL and Key in Settings.');
    }

    if (!this.client.defaults.baseURL || !this.client.defaults.headers?.['X-Api-Key']) {
      throw new Error('Sonarr client configuration is invalid. Please check your Sonarr API URL and Key in Settings.');
    }

    return this.client;
  }

  async getSeries() {
    try {
      const response = await this.ensureClient().get('/series');
      return response.data || [];
    } catch (error) {
      console.error('Sonarr get series error:', error);
      return [];
    }
  }

  async lookupSeries(term: string) {
    try {
      const response = await this.ensureClient().get('/series/lookup', {
        params: { term },
      });
      return response.data || [];
    } catch (error) {
      console.error('Sonarr lookup series error:', error);
      return [];
    }
  }

  async lookupSeriesByTvdbId(tvdbId: number) {
    try {
      const response = await this.ensureClient().get('/series/lookup', {
        params: { term: `tvdb:${tvdbId}` },
      });
      const results = response.data || [];
      return results.find((s: any) => s.tvdbId === tvdbId) || null;
    } catch (error) {
      console.error('Sonarr lookup series by TVDB ID error:', error);
      return null;
    }
  }

  async getQualityProfiles() {
    try {
      const response = await this.ensureClient().get('/qualityprofile');
      return response.data || [];
    } catch (error) {
      console.error('Sonarr get quality profiles error:', error);
      return [];
    }
  }

  async getRootFolders() {
    try {
      const response = await this.ensureClient().get('/rootfolder');
      return response.data || [];
    } catch (error) {
      console.error('Sonarr get root folders error:', error);
      return [];
    }
  }

  async addSeries(series: any, qualityProfileId?: number, rootFolderPath?: string) {
    try {
      // Get quality profile if not provided
      let finalQualityProfileId = qualityProfileId;
      if (!finalQualityProfileId) {
        const profiles = await this.getQualityProfiles();
        if (profiles.length > 0) {
          finalQualityProfileId = profiles[0].id;
          console.log(`Using quality profile: ${profiles[0].name} (ID: ${finalQualityProfileId})`);
        } else {
          finalQualityProfileId = 1; // Fallback
        }
      }

      // Get root folder if not provided
      let finalRootFolderPath = rootFolderPath;
      if (!finalRootFolderPath) {
        const folders = await this.getRootFolders();
        if (folders.length > 0) {
          finalRootFolderPath = folders[0].path;
          console.log(`Using root folder: ${finalRootFolderPath}`);
        } else {
          finalRootFolderPath = '/tv'; // Fallback
        }
      }

      const addSeriesRequest = {
        title: series.title,
        qualityProfileId: finalQualityProfileId,
        rootFolderPath: finalRootFolderPath,
        tvdbId: series.tvdbId,
        tvRageId: series.tvRageId,
        tvMazeId: series.tvMazeId,
        monitored: true,
        addOptions: {
          searchForMissingEpisodes: false,
          searchForCutoffUnmetEpisodes: false,
        },
        seasons: series.seasons || [],
      };
      const response = await this.ensureClient().post('/series', addSeriesRequest);
      return response.data;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Sonarr add series error:', errorMessage, error?.response?.data);
      throw new Error(`Failed to add series to Sonarr: ${errorMessage}`);
    }
  }
}

export default new SonarrClient();


