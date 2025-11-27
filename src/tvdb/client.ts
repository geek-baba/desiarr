import axios, { AxiosInstance } from 'axios';
import { settingsModel } from '../models/settings';

class TvdbClient {
  private apiKey: string = '';
  private userPin: string = '';
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api4.thetvdb.com/v4',
      timeout: 30000,
    });
    this.loadCredentials();
  }

  private loadCredentials() {
    const allSettings = settingsModel.getAll();
    this.apiKey = allSettings.find((s) => s.key === 'tvdb_api_key')?.value || '';
    this.userPin = allSettings.find((s) => s.key === 'tvdb_user_pin')?.value || '';

    console.log(
      'TVDB client credentials loaded - API Key:',
      this.apiKey ? 'Set' : 'Not set',
      'PIN:',
      this.userPin ? 'Set' : 'Not set'
    );
  }

  updateConfig() {
    this.loadCredentials();
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  private async authenticate(): Promise<string> {
    if (!this.apiKey) {
      throw new Error('TVDB API key not configured. Please add it in Settings.');
    }

    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    try {
      const payload: Record<string, string> = {
        apikey: this.apiKey,
      };

      if (this.userPin) {
        payload.pin = this.userPin;
      }

      const response = await this.client.post('/login', payload);
      const token = response.data?.data?.token;
      if (!token) {
        throw new Error('TVDB login response missing token');
      }

      this.token = token;
      // TVDB tokens are valid for 24 hours; refresh slightly earlier.
      this.tokenExpiresAt = now + 23 * 60 * 60 * 1000;
      return token;
    } catch (error: any) {
      console.error('TVDB authentication error:', error?.response?.data || error?.message || error);
      throw new Error('Failed to authenticate with TVDB. Please verify API key' + (this.userPin ? ' and PIN' : '') + '.');
    }
  }

  private async ensureAuthHeaders() {
    const token = await this.authenticate();
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async request<T = any>(method: 'get' | 'post', path: string, data?: any, params?: Record<string, any>): Promise<T> {
    const headers = await this.ensureAuthHeaders();
    const response = await this.client.request<T>({
      method,
      url: path,
      data,
      params,
      headers,
    });
    return response.data;
  }

  async searchSeries(query: string): Promise<any[]> {
    try {
      const response = await this.request<{ data: { tvdb_id?: number; id?: number; [key: string]: any }[] }>('get', '/search', undefined, { query, type: 'series' });
      // TVDB v4 API returns { data: [...] }
      if (response && (response as any).data && Array.isArray((response as any).data)) {
        return (response as any).data;
      }
      return [];
    } catch (error: any) {
      console.error('TVDB search series error:', error?.response?.data || error?.message || error);
      return [];
    }
  }

  async getSeries(tvdbId: number): Promise<any | null> {
    try {
      const response = await this.request<{ data: any }>('get', `/series/${tvdbId}`);
      if (response && (response as any).data) {
        return (response as any).data;
      }
      return null;
    } catch (error: any) {
      console.error('TVDB get series error:', error?.response?.data || error?.message || error);
      return null;
    }
  }

  async getSeriesExtended(tvdbId: number): Promise<any | null> {
    try {
      const response = await this.request<{ data: any }>('get', `/series/${tvdbId}/extended`);
      if (response && (response as any).data) {
        return (response as any).data;
      }
      return null;
    } catch (error: any) {
      console.error('TVDB get series extended error:', error?.response?.data || error?.message || error);
      return null;
    }
  }
}

export default new TvdbClient();


