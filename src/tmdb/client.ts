import axios, { AxiosInstance } from 'axios';

export interface TMDBProductionCountry {
  iso_3166_1: string;
  name: string;
}

export interface TMDBGenre {
  id: number;
  name: string;
}

export interface TMDBProductionCompany {
  id: number;
  name: string;
  logo_path?: string;
  origin_country?: string;
}

export interface TMDBSpokenLanguage {
  iso_639_1: string;
  name: string;
  english_name?: string;
}

export interface TMDBCollection {
  id: number;
  name: string;
  poster_path?: string;
  backdrop_path?: string;
}

export interface TMDBMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string;
  backdrop_path?: string;
  original_language?: string;
  imdb_id?: string;
  overview?: string;
  tagline?: string;
  production_countries?: TMDBProductionCountry[];
  genres?: TMDBGenre[];
  production_companies?: TMDBProductionCompany[];
  spoken_languages?: TMDBSpokenLanguage[];
  belongs_to_collection?: TMDBCollection;
  budget?: number;
  revenue?: number;
  runtime?: number;
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
  status?: string;
  adult?: boolean;
  video?: boolean;
  homepage?: string;
  // Extended data (via append_to_response)
  credits?: any;
  keywords?: { keywords: Array<{ id: number; name: string }> };
  videos?: any;
  images?: any;
  external_ids?: any;
  recommendations?: any;
  similar?: any;
  reviews?: any;
}

interface TMDBChangesResponse {
  results: Array<{
    id: number;
    adult?: boolean;
  }>;
  page: number;
  total_pages: number;
  total_results: number;
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
        // If we have a year, prefer results that match the year exactly
        if (year) {
          const yearMatch = response.data.results.find(movie => {
            if (movie.release_date) {
              const releaseYear = new Date(movie.release_date).getFullYear();
              return releaseYear === year;
            }
            return false;
          });
          if (yearMatch) {
            return yearMatch;
          }
        }
        
        // Return first result
        return response.data.results[0];
      }
      
      return null;
    } catch (error) {
      console.error('TMDB search error:', error);
      return null;
    }
  }

  async searchMovies(query: string, year?: number, limit: number = 10): Promise<TMDBMovie[]> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping search');
      return [];
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
        // If we have a year, prioritize results that match the year
        let results = response.data.results;
        if (year) {
          const yearMatches = results.filter(movie => {
            if (movie.release_date) {
              const releaseYear = new Date(movie.release_date).getFullYear();
              return releaseYear === year;
            }
            return false;
          });
          if (yearMatches.length > 0) {
            // Put year matches first, then others
            const others = results.filter(m => !yearMatches.includes(m));
            results = [...yearMatches, ...others];
          }
        }
        
        return results.slice(0, limit);
      }
      
      return [];
    } catch (error) {
      console.error('TMDB search movies error:', error);
      return [];
    }
  }

  async getMovie(tmdbId: number, includeExtended: boolean = false): Promise<TMDBMovie | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping fetch');
      return null;
    }

    try {
      const params: any = {
        api_key: this.apiKey,
        language: 'en-US',
      };

      // Use append_to_response for extended data (credits, keywords, videos, images, etc.)
      if (includeExtended) {
        params.append_to_response = 'credits,keywords,videos,images,external_ids,recommendations,similar,reviews';
      }

      const response = await this.client.get<TMDBMovie>(`/movie/${tmdbId}`, { params });
      
      return response.data;
    } catch (error: any) {
      // 404 errors are expected when TMDB ID is invalid - handle gracefully
      if (error?.response?.status === 404) {
        console.log(`TMDB movie ${tmdbId} not found (404) - ID may be invalid or movie removed`);
        return null;
      }
      // Log other errors (network issues, rate limits, etc.)
      console.error('TMDB get movie error:', error?.response?.status || error?.message || error);
      return null;
    }
  }

  /**
   * Find TMDB movie by IMDB ID
   */
  async findMovieByImdbId(imdbId: string): Promise<TMDBMovie | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping search');
      return null;
    }

    try {
      const response = await this.client.get<any>(`/find/${imdbId}`, {
        params: {
          api_key: this.apiKey,
          external_source: 'imdb_id',
        },
      });
      
      if (response.data.movie_results && response.data.movie_results.length > 0) {
        return response.data.movie_results[0];
      }
      
      return null;
    } catch (error: any) {
      // 404 errors are expected when IMDB ID doesn't map to a TMDB movie
      if (error?.response?.status === 404) {
        console.log(`TMDB movie not found for IMDB ID ${imdbId} (404) - may not exist in TMDB`);
        return null;
      }
      // Log other errors
      console.error('TMDB find by IMDB ID error:', error?.response?.status || error?.message || error);
      return null;
    }
  }

  getPosterUrl(posterPath: string | null | undefined): string | null {
    if (!posterPath) return null;
    return `https://image.tmdb.org/t/p/w500${posterPath}`;
  }

  async searchTv(query: string): Promise<any[] | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping TV search');
      return null;
    }

    try {
      const response = await this.client.get<any>('/search/tv', {
        params: {
          api_key: this.apiKey,
          query: query,
          language: 'en-US',
        },
      });
      
      return response.data.results || [];
    } catch (error: any) {
      // Log search errors (usually not 404s, but network/rate limit issues)
      console.error('TMDB TV search error:', error?.response?.status || error?.message || error);
      return null;
    }
  }

  async getTvShow(tmdbId: number): Promise<any | null> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping TV show fetch');
      return null;
    }

    try {
      const response = await this.client.get<any>(`/tv/${tmdbId}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US',
          append_to_response: 'external_ids',
        },
      });
      
      return response.data;
    } catch (error: any) {
      // 404 errors are expected when TMDB ID is invalid - handle gracefully
      if (error?.response?.status === 404) {
        console.log(`TMDB TV show ${tmdbId} not found (404) - ID may be invalid or show removed`);
        return null;
      }
      // Log other errors
      console.error('TMDB get TV show error:', error?.response?.status || error?.message || error);
      return null;
    }
  }

  /**
   * Get list of movies that changed between two dates
   * Used for incremental sync
   */
  async getMovieChanges(startDate: string, endDate: string): Promise<number[]> {
    if (!this.apiKey) {
      console.log('TMDB API key not configured, skipping changes fetch');
      return [];
    }

    const changedIds: number[] = [];
    let page = 1;
    let totalPages = 1;

    try {
      do {
        const response = await this.client.get<TMDBChangesResponse>('/movie/changes', {
          params: {
            api_key: this.apiKey,
            start_date: startDate, // YYYY-MM-DD format
            end_date: endDate, // YYYY-MM-DD format
            page: page,
          },
        });

        if (response.data.results) {
          // Filter out adult content and collect IDs
          const movieIds = response.data.results
            .filter(result => !result.adult)
            .map(result => result.id);
          changedIds.push(...movieIds);
        }

        totalPages = response.data.total_pages || 1;
        page++;

        // Rate limit: wait 350ms between pages (3 req/sec)
        if (page <= totalPages) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      } while (page <= totalPages);

      return changedIds;
    } catch (error: any) {
      console.error('TMDB get movie changes error:', error?.response?.status || error?.message || error);
      return changedIds; // Return what we got so far
    }
  }
}

export { TMDBClient };
export default new TMDBClient();

