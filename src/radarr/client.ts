import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { settingsModel } from '../models/settings';
import { RadarrMovie, RadarrLookupResult, RadarrMovieFile, RadarrHistory, RadarrQualityProfile, RadarrRootFolder } from './types';

class RadarrClient {
  private client: AxiosInstance | null = null;

  constructor() {
    this.initializeClient();
  }

  private initializeClient() {
    // ONLY get from settings - do NOT fall back to environment variables
    const allSettings = settingsModel.getAll();
    const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value;
    const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key')?.value;

    console.log('Radarr client initialization - URL:', radarrApiUrl ? 'Set' : 'Not set', 'Key:', radarrApiKey ? 'Set' : 'Not set');

    if (radarrApiUrl && radarrApiKey) {
      this.client = axios.create({
        baseURL: radarrApiUrl,
        headers: {
          'X-Api-Key': radarrApiKey,
        },
        timeout: 30000, // 30 second timeout
      });
      console.log('Radarr client initialized with URL:', radarrApiUrl);
    } else {
      // Don't create a dummy client - let ensureClient throw an error
      this.client = null;
      console.log('Radarr client NOT initialized - missing URL or Key');
    }
  }

  // Method to update client configuration when settings change
  updateConfig() {
    this.initializeClient();
  }

  private ensureClient(): AxiosInstance {
    // Always re-initialize to get latest settings
    this.initializeClient();
    
    if (!this.client) {
      const allSettings = settingsModel.getAll();
      const radarrApiUrl = allSettings.find(s => s.key === 'radarr_api_url')?.value;
      const radarrApiKey = allSettings.find(s => s.key === 'radarr_api_key')?.value;
      
      console.error('Radarr client not initialized. URL:', radarrApiUrl ? 'Set' : 'Not set', 'Key:', radarrApiKey ? 'Set' : 'Not set');
      
      if (!radarrApiUrl || !radarrApiKey) {
        throw new Error('Radarr API not configured. Please configure Radarr API URL and Key in Settings page.');
      } else {
        throw new Error('Radarr client initialization failed. Please check your Radarr API URL and Key in Settings.');
      }
    }
    
    // Verify client has valid baseURL and API key
    if (!this.client.defaults.baseURL || !this.client.defaults.headers?.['X-Api-Key']) {
      console.error('Radarr client has invalid configuration. baseURL:', this.client.defaults.baseURL, 'API Key:', this.client.defaults.headers?.['X-Api-Key'] ? 'Set' : 'Not set');
      throw new Error('Radarr client configuration is invalid. Please check your Radarr API URL and Key in Settings.');
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
      const client = this.ensureClient();
      console.log('Making request to:', client.defaults.baseURL + '/movie');
      const response = await client.get<RadarrMovie[]>('/movie');
      console.log('Response status:', response.status, 'Data length:', response.data?.length || 0);
      return response.data || [];
    } catch (error: any) {
      console.error('Radarr get all movies error:', error);
      console.error('Error response:', error?.response?.data);
      console.error('Error status:', error?.response?.status);
      console.error('Error message:', error?.message);
      
      let errorMessage = 'Unknown error';
      if (error?.response?.status === 401) {
        errorMessage = 'Unauthorized - Invalid API key. Please check your Radarr API key in Settings.';
      } else if (error?.response?.status === 404) {
        errorMessage = 'Not found - Invalid Radarr API URL. Please check your Radarr API URL in Settings.';
      } else if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
        errorMessage = `Connection failed - Cannot reach Radarr at ${error?.config?.baseURL || 'the configured URL'}. Please check your Radarr API URL and ensure Radarr is running.`;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      throw new Error(`Failed to fetch movies from Radarr: ${errorMessage}`);
    }
  }

  async getQualityProfiles(): Promise<RadarrQualityProfile[]> {
    try {
      const response = await this.ensureClient().get<RadarrQualityProfile[]>('/qualityprofile');
      return response.data || [];
    } catch (error) {
      console.error('Radarr get quality profiles error:', error);
      return [];
    }
  }

  async getRootFolders(): Promise<RadarrRootFolder[]> {
    try {
      const response = await this.ensureClient().get<RadarrRootFolder[]>('/rootfolder');
      return response.data || [];
    } catch (error) {
      console.error('Radarr get root folders error:', error);
      return [];
    }
  }

  async lookupMovieByTmdbId(tmdbId: number): Promise<RadarrLookupResult | null> {
    try {
      const response = await this.ensureClient().get<RadarrLookupResult>(`/movie/lookup/tmdb`, {
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

  /**
   * Refresh a movie in Radarr (triggers Radarr to re-fetch metadata from TMDB)
   * POST /api/v3/command with name: 'RefreshMovie'
   */
  async refreshMovie(movieId: number): Promise<void> {
    try {
      await this.ensureClient().post(`/command`, {
        name: 'RefreshMovie',
        movieIds: [movieId],
      });
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Radarr refresh movie error:', errorMessage);
      throw new Error(`Failed to refresh movie in Radarr: ${errorMessage}`);
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

  /**
   * Delete a movie from Radarr
   * @param movieId Radarr movie ID
   * @param deleteFiles Whether to delete movie files from disk (default: false)
   * @param addImportExclusion Whether to add to import exclusion list (default: false)
   */
  async deleteMovie(movieId: number, deleteFiles: boolean = false, addImportExclusion: boolean = false): Promise<void> {
    try {
      await this.ensureClient().delete(`/movie/${movieId}`, {
        params: {
          deleteFiles,
          addImportExclusion,
        },
      });
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Radarr delete movie error:', errorMessage, error?.response?.data);
      throw new Error(`Failed to delete movie from Radarr: ${errorMessage}`);
    }
  }

  /**
   * Update an existing movie in Radarr
   * @param movieId Radarr movie ID
   * @param updates Partial movie object with fields to update (e.g., { tmdbId: 12345 })
   */
  async updateMovie(movieId: number, updates: Partial<RadarrMovie>): Promise<RadarrMovie> {
    try {
      // First, get the current movie to merge with updates
      const currentMovie = await this.getMovie(movieId);
      if (!currentMovie) {
        throw new Error(`Movie with ID ${movieId} not found in Radarr`);
      }

      // Merge current movie with updates
      const updatedMovie = {
        ...currentMovie,
        ...updates,
        id: movieId, // Ensure ID is set
      };

      const response = await this.ensureClient().put<RadarrMovie>(`/movie/${movieId}`, updatedMovie);
      return response.data;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Radarr update movie error:', errorMessage, error?.response?.data);
      throw new Error(`Failed to update movie in Radarr: ${errorMessage}`);
    }
  }

  /**
   * Manual Import - Link existing files to a movie
   * @param params Manual import parameters
   * @param params.movieId The movie ID to import files to
   * @param params.files Array of file objects with path, quality, and languages
   * @param params.folder The movie folder path (optional, Radarr may auto-detect)
   * @param params.importMode Import mode: "Auto", "Move", or "Copy" (default: "Auto")
   * 
   * Note: Manual Import does NOT move files - it just maps/links existing files to the movie.
   * Files stay in their current location. If rename/move is needed, trigger manual rename separately.
   */
  /**
   * Get list of files available for manual import from a folder
   * GET /api/v3/manualimport?folder=<folder>
   */
  async getManualImportFiles(folder: string, filterExistingFiles: boolean = true): Promise<any[]> {
    try {
      const response = await this.ensureClient().get('/manualimport', {
        params: {
          folder: folder,
          filterExistingFiles: filterExistingFiles,
        },
      });
      return response.data || [];
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('[Radarr] Get Manual Import files error:', errorMessage);
      throw new Error(`Failed to get manual import files: ${errorMessage}`);
    }
  }

  /**
   * Execute manual import of files
   * POST /api/v3/manualimport
   * Takes file objects from GET response, adds movieId and imported: true
   */
  async manualImport(files: any[]): Promise<void> {
    try {
      // Log the exact payload we're sending for debugging
      console.log('[Radarr Manual Import] Sending POST request:', JSON.stringify(files, null, 2));

      const response = await this.ensureClient().post('/manualimport', files);
      
      // Log the response
      console.log('[Radarr Manual Import] Response:', JSON.stringify(response.data, null, 2));
      
      return response.data;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error';
      const errorDetails = error?.response?.data;
      
      // Log full error details for debugging
      console.error('[Radarr Manual Import] Full error:', {
        message: errorMessage,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: errorDetails,
        requestPayload: files,
      });
      
      throw new Error(`Failed to manual import files: ${errorMessage}`);
    }
  }
}

export { RadarrClient };
export default new RadarrClient();

