import { Resolution, Codec } from './Release';

// Re-export for convenience
export type { Resolution, Codec };

export interface ResolutionRule {
  resolution: Resolution;
  allowed: boolean;
  preferredCodecs?: string[];
  discouragedCodecs?: string[];
}

export interface QualitySettings {
  resolutions: ResolutionRule[];
  resolutionWeights: { [res: string]: number };
  sourceTagWeights: { [tag: string]: number };
  codecWeights: { [codec: string]: number };
  audioWeights: { [pattern: string]: number };
  preferredAudioLanguages: string[];
  dubbedPenalty: number;
  preferredLanguageBonus: number;
  sizeBonusEnabled: boolean;
  minSizeIncreasePercentForUpgrade: number;
  upgradeThreshold: number;
  /**
   * Percentage size increase at which a release should be considered an upgrade
   * purely based on size, regardless of quality score.
   *
   * Example: 25 means "if new file is >=25% larger than existing, tag as upgrade".
   */
  sizeOnlyUpgradePercent?: number;
}

export interface AppSettings {
  pollIntervalMinutes: number;
  radarrSyncIntervalHours: number;
  sonarrSyncIntervalHours: number;
  rssSyncIntervalHours: number;
}

export interface ParsedRelease {
  resolution: Resolution;
  sourceTag: string;
  codec: Codec;
  audio: string;
  sizeMb?: number;
  audioLanguages?: string[];
}

