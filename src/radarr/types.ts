export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  tmdbId: number;
  imdbId?: string;
  path?: string;
  hasFile?: boolean;
  movieFile?: RadarrMovieFile;
  originalLanguage?: {
    id: number;
    name: string;
  };
  images?: Array<{
    coverType: string;
    url?: string;
    remoteUrl?: string;
  }>;
}

export interface RadarrMovieFile {
  id: number;
  relativePath: string;
  size: number;
  quality?: {
    quality: {
      id: number;
      name: string;
      resolution?: string;
      source?: string;
    };
  };
  mediaInfo?: {
    audioCodec?: string;
    audioChannels?: number;
    audioLanguages?: string[];
    videoCodec?: string;
    videoBitDepth?: number;
    resolution?: string;
  };
}

export interface RadarrHistory {
  id: number;
  movieId: number;
  sourceTitle: string;
  quality?: {
    quality: {
      id: number;
      name: string;
      resolution?: string;
      source?: string;
    };
  };
  date: string;
  eventType: string;
  data?: {
    indexer?: string;
    nzbInfoUrl?: string;
    releaseGroup?: string;
    age?: number;
    ageHours?: number;
    ageMinutes?: number;
    publishedDate?: string;
    downloadUrl?: string;
    guid?: string;
    protocol?: string;
    torrentInfoHash?: string;
    size?: number;
  };
}

export interface RadarrLookupResult {
  title: string;
  year?: number;
  tmdbId: number;
  originalLanguage?: {
    id: number;
    name: string;
  };
}

