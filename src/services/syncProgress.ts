// Simple in-memory sync progress tracker
interface SyncProgress {
  isRunning: boolean;
  type: 'radarr' | 'rss' | 'matching' | 'full' | 'sonarr' | 'tv-matching';
  currentStep: string;
  progress: number; // 0-100
  total: number;
  processed: number;
  errors: number;
  startTime?: Date;
  endTime?: Date;
  details?: string[]; // Array of detail messages (e.g., "3 new movies: Movie A, Movie B, Movie C")
}

let currentProgress: SyncProgress | null = null;

export const syncProgress = {
  start: (type: 'radarr' | 'rss' | 'matching' | 'full' | 'sonarr' | 'tv-matching', total: number = 0) => {
    currentProgress = {
      isRunning: true,
      type,
      currentStep: 'Starting...',
      progress: 0,
      total,
      processed: 0,
      errors: 0,
      startTime: new Date(),
      details: [],
    };
  },

  update: (step: string, processed: number, total?: number, errors: number = 0, details?: string[]) => {
    if (currentProgress) {
      currentProgress.currentStep = step;
      currentProgress.processed = processed;
      currentProgress.errors = errors;
      if (total !== undefined) {
        currentProgress.total = total;
      }
      if (currentProgress.total > 0) {
        currentProgress.progress = Math.round((processed / currentProgress.total) * 100);
      }
      if (details) {
        currentProgress.details = details;
      }
    }
  },

  complete: () => {
    if (currentProgress) {
      currentProgress.isRunning = false;
      currentProgress.progress = 100;
      currentProgress.endTime = new Date();
    }
  },

  get: (): SyncProgress | null => {
    return currentProgress;
  },

  clear: () => {
    currentProgress = null;
  },

  error: (message: string) => {
    if (currentProgress) {
      currentProgress.currentStep = message;
      currentProgress.isRunning = false;
      currentProgress.errors = currentProgress.errors + 1;
      currentProgress.endTime = new Date();
    }
  },
};

