import axios, { AxiosInstance } from 'axios';

interface OMDBSearchResult {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster?: string;
}

interface OMDBResponse {
  Response: string;
  Search?: OMDBSearchResult[];
  totalResults?: string;
  Error?: string;
}

class IMDBClient {
  private client: AxiosInstance;
  private apiKey: string | null = null;

  constructor() {
    // OMDB API is free and doesn't require authentication for basic searches
    // But we can use an API key if provided for higher rate limits
    this.client = axios.create({
      baseURL: 'https://www.omdbapi.com',
    });
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Search for a movie by title and year using OMDB API
   * Returns the IMDB ID if found
   */
  async searchMovie(query: string, year?: number): Promise<{ imdbId: string; title: string; year: string } | null> {
    try {
      const params: any = {
        s: query,
        type: 'movie',
      };
      
      if (this.apiKey) {
        params.apikey = this.apiKey;
      }
      
      if (year) {
        params.y = year;
      }

      const response = await this.client.get<OMDBResponse>('/', { params });
      
      if (response.data.Response === 'True' && response.data.Search && response.data.Search.length > 0) {
        console.log(`      OMDB returned ${response.data.Search.length} results. First 3:`, 
          response.data.Search.slice(0, 3).map(m => `"${m.Title}" (${m.Year})`).join(', '));
        
        // If we have a year, prefer results that match the year exactly
        if (year) {
          const yearMatch = response.data.Search.find(movie => {
            const movieYear = parseInt(movie.Year.split('–')[0], 10); // Handle ranges like "2025–2026"
            return movieYear === year;
          });
          if (yearMatch) {
            console.log(`      Selected year-matched result: "${yearMatch.Title}" (${yearMatch.Year})`);
            return {
              imdbId: yearMatch.imdbID,
              title: yearMatch.Title,
              year: yearMatch.Year,
            };
          } else {
            console.log(`      No year match found in OMDB results for year ${year}`);
          }
        }
        
        // Return first result
        const first = response.data.Search[0];
        console.log(`      Using first OMDB result: "${first.Title}" (${first.Year})`);
        return {
          imdbId: first.imdbID,
          title: first.Title,
          year: first.Year,
        };
      }
      
      if (response.data.Error) {
        console.log(`      OMDB error: ${response.data.Error}`);
      }
      
      return null;
    } catch (error) {
      console.error('IMDB/OMDB search error:', error);
      return null;
    }
  }


  /**
   * Search for a TV series by title using OMDB API
   * Returns the IMDB ID if found
   */
  async searchByTitle(query: string, type: 'movie' | 'series' = 'movie'): Promise<{ imdbId: string; title: string; year: string } | null> {
    try {
      const params: any = {
        s: query,
        type: type,
      };
      
      if (this.apiKey) {
        params.apikey = this.apiKey;
      }

      const response = await this.client.get<OMDBResponse>('/', { params });
      
      if (response.data.Response === 'True' && response.data.Search && response.data.Search.length > 0) {
        const first = response.data.Search[0];
        return {
          imdbId: first.imdbID,
          title: first.Title,
          year: first.Year,
        };
      }
      
      return null;
    } catch (error) {
      console.error('IMDB/OMDB search error:', error);
      return null;
    }
  }

  /**
   * Get movie details by IMDB ID
   */
  async getMovieByImdbId(imdbId: string): Promise<any | null> {
    try {
      const params: any = {
        i: imdbId,
        type: 'movie',
      };
      
      if (this.apiKey) {
        params.apikey = this.apiKey;
      }

      const response = await this.client.get('/', { params });
      
      if (response.data.Response === 'True') {
        return response.data;
      }
      
      return null;
    } catch (error) {
      console.error('IMDB/OMDB get movie error:', error);
      return null;
    }
  }
}

export default new IMDBClient();

