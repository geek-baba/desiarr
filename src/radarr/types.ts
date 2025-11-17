export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  tmdbId: number;
  path?: string;
  hasFile?: boolean;
  movieFile?: RadarrMovieFile;
  originalLanguage?: {
    id: number;
    name: string;
  };
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

