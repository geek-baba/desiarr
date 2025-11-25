export type ReleaseStatus = 'NEW' | 'UPGRADE_CANDIDATE' | 'IGNORED' | 'ADDED' | 'UPGRADED' | 'ATTENTION_NEEDED';
export type TvReleaseStatus = 'NEW_SHOW' | 'NEW_SEASON' | 'IGNORED' | 'ADDED' | 'ATTENTION_NEEDED';
export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'UNKNOWN';
export type Codec = 'x265' | 'HEVC' | 'x264' | 'AVC' | 'UNKNOWN';

// Legacy alias for backward compatibility during migration
export type Release = MovieRelease;

export interface MovieRelease {
  id?: number;
  guid: string;
  title: string;
  normalized_title: string;
  year?: number;
  source_site: string;
  feed_id: number;
  link: string;
  resolution: Resolution;
  source_tag: string;
  codec: Codec;
  audio: string;
  rss_size_mb?: number;
  existing_size_mb?: number;
  published_at: string;
  tmdb_id?: number;
  tmdb_title?: string;
  tmdb_original_language?: string;
  tmdb_poster_url?: string;
  imdb_id?: string;
  is_dubbed?: boolean;
  audio_languages?: string;
  radarr_movie_id?: number;
  radarr_movie_title?: string;
  radarr_existing_quality_score?: number;
  new_quality_score?: number;
  status: ReleaseStatus;
  last_checked_at: string;
  existing_file_path?: string;
  existing_file_attributes?: string;
  radarr_history?: string;
  manually_ignored?: boolean;
}

export interface TvRelease {
  id?: number;
  guid: string;
  title: string;
  normalized_title: string;
  show_name: string;
  season_number?: number;
  source_site: string;
  feed_id: number;
  link: string;
  published_at: string;
  tvdb_id?: number;
  tmdb_id?: number;
  imdb_id?: string;
  tvdb_poster_url?: string;
  tmdb_poster_url?: string;
  sonarr_series_id?: number;
  sonarr_series_title?: string;
  status: TvReleaseStatus;
  last_checked_at: string;
  manually_ignored?: boolean;
}

