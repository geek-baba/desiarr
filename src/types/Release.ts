export type ReleaseStatus = 'NEW' | 'UPGRADE_CANDIDATE' | 'IGNORED' | 'ADDED' | 'UPGRADED';
export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'UNKNOWN';
export type Codec = 'x265' | 'HEVC' | 'x264' | 'AVC' | 'UNKNOWN';

export interface Release {
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
  is_dubbed?: boolean;
  audio_languages?: string;
  radarr_movie_id?: number;
  radarr_movie_title?: string;
  radarr_existing_quality_score?: number;
  new_quality_score?: number;
  status: ReleaseStatus;
  last_checked_at: string;
}

