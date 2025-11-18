import axios, { AxiosInstance } from 'axios';
import { config } from '../config';

interface TMDBMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string;
  backdrop_path?: string;
  original_language?: string;
  imdb_id?: string;
}

interface TMDBSearchResponse {
  results: TMDBMovie[];
  total_results: number;
}

class TMDBClient {
  private client: AxiosInstance;
  private apiKey: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
    });
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  async searchMovie(query: string, year?: number): Promise<TMDBMovie | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping search');
      return null;
    }

    try {
      const params: any = {
        api_key: this.apiKey,
        query: query,
        language: 'en-US',
      };
      
      if (year) {
        params.year = year;
      }

      const response = await this.client.get<TMDBSearchResponse>('/search/movie', { params });
      
      if (response.data.results && response.data.results.length > 0) {
        return response.data.results[0];
      }
      
      return null;
    } catch (error) {
      console.error('TMDB search error:', error);
      return null;
    }
  }

  async getMovie(tmdbId: number): Promise<TMDBMovie | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping fetch');
      return null;
    }

    try {
      const response = await this.client.get<TMDBMovie>(`/movie/${tmdbId}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US',
        },
      });
      
      return response.data;
    } catch (error) {
      console.error('TMDB get movie error:', error);
      return null;
    }
  }

  getPosterUrl(posterPath: string | null | undefined): string | null {
    if (!posterPath) return null;
    return `https://image.tmdb.org/t/p/w500${posterPath}`;
  }
}

export default new TMDBClient();

