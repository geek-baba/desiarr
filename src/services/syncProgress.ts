// Simple in-memory sync progress tracker
interface SyncProgress {
  isRunning: boolean;
  type: 'radarr' | 'rss' | 'matching' | 'full';
  currentStep: string;
  progress: number; // 0-100
  total: number;
  processed: number;
  errors: number;
  startTime?: Date;
  endTime?: Date;
}

let currentProgress: SyncProgress | null = null;

export const syncProgress = {
  start: (type: 'radarr' | 'rss' | 'matching' | 'full', total: number = 0) => {
    currentProgress = {
      isRunning: true,
      type,
      currentStep: 'Starting...',
      progress: 0,
      total,
      processed: 0,
      errors: 0,
      startTime: new Date(),
    };
  },

  update: (step: string, processed: number, total?: number, errors: number = 0) => {
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
};

