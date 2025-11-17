import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { RadarrMovie, RadarrLookupResult } from './types';

class RadarrClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.radarr.apiUrl,
      headers: {
        'X-Api-Key': config.radarr.apiKey,
      },
    });
  }

  async lookupMovie(term: string): Promise<RadarrLookupResult[]> {
    try {
      const response = await this.client.get<RadarrLookupResult[]>('/movie/lookup', {
        params: { term },
      });
      return response.data;
    } catch (error) {
      console.error('Radarr lookup error:', error);
      return [];
    }
  }

  async getMovie(tmdbId: number): Promise<RadarrMovie | null> {
    try {
      const response = await this.client.get<RadarrMovie[]>('/movie', {
        params: { tmdbId },
      });
      return response.data[0] || null;
    } catch (error) {
      console.error('Radarr get movie error:', error);
      return null;
    }
  }

  async getAllMovies(): Promise<RadarrMovie[]> {
    try {
      const response = await this.client.get<RadarrMovie[]>('/movie');
      return response.data;
    } catch (error) {
      console.error('Radarr get all movies error:', error);
      return [];
    }
  }

  async addMovie(movie: RadarrLookupResult, qualityProfileId: number = 1, rootFolderPath: string = '/movies'): Promise<RadarrMovie> {
    try {
      const addMovieRequest = {
        title: movie.title,
        year: movie.year,
        qualityProfileId,
        rootFolderPath,
        tmdbId: movie.tmdbId,
        monitored: true,
        addOptions: {
          searchForMovie: false,
        },
      };
      const response = await this.client.post<RadarrMovie>('/movie', addMovieRequest);
      return response.data;
    } catch (error) {
      console.error('Radarr add movie error:', error);
      throw error;
    }
  }

  async getMovieFile(movieId: number): Promise<RadarrMovieFile | null> {
    try {
      const movie = await this.client.get<RadarrMovie>(`/movie/${movieId}`);
      return movie.data.movieFile || null;
    } catch (error) {
      console.error('Radarr get movie file error:', error);
      return null;
    }
  }

  async triggerSearch(movieId: number): Promise<void> {
    try {
      await this.client.post(`/command`, {
        name: 'MoviesSearch',
        movieIds: [movieId],
      });
    } catch (error) {
      console.error('Radarr trigger search error:', error);
      throw error;
    }
  }
}

export default new RadarrClient();

