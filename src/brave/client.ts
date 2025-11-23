import axios, { AxiosInstance } from 'axios';

interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description?: string;
    }>;
  };
}

class BraveClient {
  private client: AxiosInstance;
  private apiKey: string | null = null;
  private lastRequestTime: number = 0;
  private readonly minRequestInterval: number = 1000; // 1 second (1000ms) between requests

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.search.brave.com/res/v1',
      timeout: 15000, // 15 second timeout
    });
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Rate limiter: Ensures at least 1 second between requests
   * to respect Brave API's 1 request per second limit
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      console.log(`    ⏳ Rate limiting: waiting ${waitTime}ms before next Brave API request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Search the web using Brave Search API
   * Returns an array of search results with title and URL
   * Automatically rate-limited to 1 request per second
   */
  async searchWeb(query: string, count: number = 5): Promise<BraveSearchResult[]> {
    if (!this.apiKey) {
      console.log('Brave API key not configured, skipping search');
      return [];
    }

    // Rate limit: wait if needed to respect 1 request/second limit
    await this.waitForRateLimit();

    try {
      const response = await this.client.get<BraveWebSearchResponse>('/web/search', {
        headers: {
          'X-Subscription-Token': this.apiKey,
          'Accept': 'application/json',
        },
        params: {
          q: query,
          count: count,
        },
      });

      if (response.data.web?.results && response.data.web.results.length > 0) {
        return response.data.web.results.map(result => ({
          title: result.title,
          url: result.url,
          description: result.description,
        }));
      }

      return [];
    } catch (error: any) {
      // Handle rate limiting (429) gracefully
      if (error?.response?.status === 429 || error?.response?.data?.error?.code === 'RATE_LIMITED') {
        const errorData = error?.response?.data?.error || {};
        console.warn(`⚠️ Brave API rate limit exceeded (429). Plan: ${errorData.meta?.plan || 'unknown'}, Rate limit: ${errorData.meta?.rate_limit || 'unknown'}/sec. Skipping Brave search for this request.`);
        // Throw a specific error that callers can catch to skip Brave search
        throw new Error('BRAVE_RATE_LIMITED');
      }
      console.error('Brave search error:', error?.response?.data || error?.message || error);
      return [];
    }
  }

  /**
   * Extract IMDb ID from a URL
   * Matches patterns like: https://www.imdb.com/title/tt1234567/
   */
  extractImdbIdFromUrl(url: string): string | null {
    const match = url.match(/imdb\.com\/title\/(tt\d{7,})/i);
    return match ? match[1] : null;
  }

  /**
   * Extract TMDB ID from a URL
   * Matches patterns like:
   * - https://www.themoviedb.org/movie/12345-*
   * - https://www.themoviedb.org/tv/67890-*
   */
  extractTmdbIdFromUrl(url: string): number | null {
    const match = url.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Search for IMDb ID using Brave Search
   * Searches with site:imdb.com restriction
   */
  async searchForImdbId(title: string, year?: number): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      // Build query: "title" year site:imdb.com
      const query = year 
        ? `"${title}" ${year} site:imdb.com`
        : `"${title}" site:imdb.com`;

      console.log(`    Searching Brave for IMDb ID: "${query}"`);
      const results = await this.searchWeb(query, 5);

      // Look for IMDb title URLs in results
      for (const result of results) {
        const imdbId = this.extractImdbIdFromUrl(result.url);
        if (imdbId) {
          console.log(`    ✓ Found IMDb ID ${imdbId} via Brave search for "${title}"`);
          return imdbId;
        }
      }

      console.log(`    ✗ No IMDb ID found via Brave search for "${title}"`);
      return null;
    } catch (error: any) {
      console.error(`    ✗ Brave search for IMDb ID error for "${title}":`, error?.message || error);
      return null;
    }
  }

  /**
   * Search for TMDB ID using Brave Search
   * Searches with site:themoviedb.org restriction
   */
  async searchForTmdbId(title: string, year?: number): Promise<number | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      // Build query: "title" year site:themoviedb.org
      const query = year 
        ? `"${title}" ${year} site:themoviedb.org`
        : `"${title}" site:themoviedb.org`;

      console.log(`    Searching Brave for TMDB ID: "${query}"`);
      const results = await this.searchWeb(query, 5);

      // Look for TMDB movie/tv URLs in results
      for (const result of results) {
        const tmdbId = this.extractTmdbIdFromUrl(result.url);
        if (tmdbId) {
          console.log(`    ✓ Found TMDB ID ${tmdbId} via Brave search for "${title}"`);
          return tmdbId;
        }
      }

      console.log(`    ✗ No TMDB ID found via Brave search for "${title}"`);
      return null;
    } catch (error: any) {
      console.error(`    ✗ Brave search for TMDB ID error for "${title}":`, error?.message || error);
      return null;
    }
  }
}

export default new BraveClient();

