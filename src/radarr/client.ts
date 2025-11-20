import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { settingsModel } from '../models/settings';
import { RadarrMovie, RadarrLookupResult, RadarrMovieFile, RadarrHistory } from './types';

class RadarrClient {
  private client: AxiosInstance | null = null;

  constructor() {
    this.initializeClient();
  }

  private initializeClient() {
    // Try to get from settings first, fall back to environment variables
    const allSettings = settingsModel.getAll();
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value || config.radarr.apiUrl;
    const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key')?.value || config.radarr.apiKey;

    if (radarrApiUrl && radarrApiKey) {
      this.client = axios.create({
        baseURL: radarrApiUrl,
        headers: {
          'X-Api-Key': radarrApiKey,
        },
      });
    } else {
      // Create a dummy client that will fail gracefully
      this.client = axios.create({
        baseURL: '',
        headers: {
          'X-Api-Key': '',
        },
      });
    }
  }

  // Method to update client configuration when settings change
  updateConfig() {
    this.initializeClient();
  }

  private ensureClient(): AxiosInstance {
    if (!this.client) {
      this.initializeClient();
    }
    if (!this.client) {
      throw new Error('Radarr client not initialized. Please configure Radarr API URL and Key in Settings.');
    }
    return this.client;
  }

  async lookupMovie(term: string): Promise<RadarrLookupResult[]> {
    try {
      const response = await this.ensureClient().get<RadarrLookupResult[]>('/movie/lookup', {
        params: { term },
      });
      return response.data;
    } catch (error) {
      console.error('Radarr lookup error:', error);
      return [];
    }
  }

  async getMovie(tmdbIdOrRadarrId: number): Promise<RadarrMovie | null> {
    try {
      // Try to get by Radarr ID first (if it's a small number, likely Radarr ID)
      // Otherwise try by TMDB ID
      try {
        const response = await this.ensureClient().get<RadarrMovie>(`/movie/${tmdbIdOrRadarrId}`);
        return response.data;
      } catch (error) {
        // If that fails, try by TMDB ID
        const response = await this.ensureClient().get<RadarrMovie[]>('/movie', {
          params: { tmdbId: tmdbIdOrRadarrId },
        });
        return response.data[0] || null;
      }
    } catch (error) {
      console.error('Radarr get movie error:', error);
      return null;
    }
  }

  async getAllMovies(): Promise<RadarrMovie[]> {
    try {
      const response = await this.ensureClient().get<RadarrMovie[]>('/movie');
      return response.data;
    } catch (error) {
      console.error('Radarr get all movies error:', error);
      return [];
    }
  }

  async getQualityProfiles(): Promise<Array<{ id: number; name: string }>> {
    try {
      const response = await this.client.get<Array<{ id: number; name: string }>>('/qualityProfile');
      return response.data || [];
    } catch (error) {
      console.error('Radarr get quality profiles error:', error);
      return [];
    }
  }

  async getRootFolders(): Promise<Array<{ id: number; path: string }>> {
    try {
      const response = await this.client.get<Array<{ id: number; path: string }>>('/rootFolder');
      return response.data || [];
    } catch (error) {
      console.error('Radarr get root folders error:', error);
      return [];
    }
  }

  async lookupMovieByTmdbId(tmdbId: number): Promise<RadarrLookupResult | null> {
    try {
      const response = await this.client.get<RadarrLookupResult>(`/movie/lookup/tmdb`, {
        params: { tmdbId },
      });
      return response.data || null;
    } catch (error) {
      console.error('Radarr lookup movie by TMDB ID error:', error);
      return null;
    }
  }

  async addMovie(movie: RadarrLookupResult, qualityProfileId?: number, rootFolderPath?: string): Promise<RadarrMovie> {
    try {
      // Get quality profile if not provided
      let finalQualityProfileId = qualityProfileId;
      if (!finalQualityProfileId) {
        const profiles = await this.getQualityProfiles();
        if (profiles.length > 0) {
          finalQualityProfileId = profiles[0].id; // Use first profile as default
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
          finalRootFolderPath = folders[0].path; // Use first folder as default
          console.log(`Using root folder: ${finalRootFolderPath}`);
        } else {
          finalRootFolderPath = '/movies'; // Fallback
        }
      }

      const addMovieRequest = {
        title: movie.title,
        year: movie.year,
        qualityProfileId: finalQualityProfileId,
        rootFolderPath: finalRootFolderPath,
        tmdbId: movie.tmdbId,
        monitored: true,
        addOptions: {
          searchForMovie: false,
        },
      };
      const response = await this.ensureClient().post<RadarrMovie>('/movie', addMovieRequest);
      return response.data;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Radarr add movie error:', errorMessage, error?.response?.data);
      throw new Error(`Failed to add movie to Radarr: ${errorMessage}`);
    }
  }

  async getMovieFile(movieId: number): Promise<RadarrMovieFile | null> {
    try {
      const movie = await this.ensureClient().get<RadarrMovie>(`/movie/${movieId}`);
      return movie.data.movieFile || null;
    } catch (error) {
      console.error('Radarr get movie file error:', error);
      return null;
    }
  }

  async triggerSearch(movieId: number): Promise<void> {
    try {
      await this.ensureClient().post(`/command`, {
        name: 'MoviesSearch',
        movieIds: [movieId],
      });
    } catch (error) {
      console.error('Radarr trigger search error:', error);
      throw error;
    }
  }

  async getMovieHistory(movieId: number): Promise<RadarrHistory[]> {
    try {
      const response = await this.ensureClient().get<RadarrHistory[]>('/history/movie', {
        params: { movieId },
      });
      return response.data || [];
    } catch (error) {
      console.error('Radarr get movie history error:', error);
      return [];
    }
  }

  async getMovieWithHistory(movieId: number): Promise<{ movie: RadarrMovie; history: RadarrHistory[] } | null> {
    try {
      const movie = await this.ensureClient().get<RadarrMovie>(`/movie/${movieId}`);
      const history = await this.getMovieHistory(movieId);
      return {
        movie: movie.data,
        history,
      };
    } catch (error) {
      console.error('Radarr get movie with history error:', error);
      return null;
    }
  }
}

export default new RadarrClient();

