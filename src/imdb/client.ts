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
        // If we have a year, prefer results that match the year exactly
        if (year) {
          const yearMatch = response.data.Search.find(movie => {
            const movieYear = parseInt(movie.Year.split('–')[0], 10); // Handle ranges like "2025–2026"
            return movieYear === year;
          });
          if (yearMatch) {
            return {
              imdbId: yearMatch.imdbID,
              title: yearMatch.Title,
              year: yearMatch.Year,
            };
          }
        }
        
        // Return first result
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
   * Search Google/DuckDuckGo for IMDB ID by movie title and year
   * Extracts IMDB ID from search results
   * Uses "clean title yyyy tmdb" format for better results
   */
  async searchGoogleForImdbId(query: string, year?: number): Promise<string | null> {
    try {
      // Construct search query - use "clean title yyyy tmdb" format
      const searchQuery = year 
        ? `${query} ${year} tmdb`
        : `${query} tmdb`;
      
      // Use DuckDuckGo HTML search (no API key needed, privacy-friendly)
      // DuckDuckGo doesn't require API keys and is more lenient with automated requests
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      
      const response = await this.client.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        responseType: 'text',
        timeout: 10000, // 10 second timeout
      });
      
      // Extract IMDB ID from search results
      // Look for patterns like imdb.com/title/tt1234567 or www.imdb.com/title/tt1234567
      const imdbPattern = /(?:www\.)?imdb\.com\/title\/(tt\d{7,})/gi;
      const matches = response.data.match(imdbPattern);
      
      if (matches && matches.length > 0) {
        // Extract the first IMDB ID found
        const imdbIdMatch = matches[0].match(/tt\d{7,}/i);
        if (imdbIdMatch) {
          console.log(`  Found IMDB ID ${imdbIdMatch[0]} via DuckDuckGo search for: "${query}"`);
          return imdbIdMatch[0];
        }
      }
      
      return null;
    } catch (error) {
      console.error('DuckDuckGo search for IMDB ID error:', error);
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

