import { Resolution, Codec } from './Release';

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
  pollIntervalMinutes: number;
}

export interface ParsedRelease {
  resolution: Resolution;
  sourceTag: string;
  codec: Codec;
  audio: string;
  sizeMb?: number;
  audioLanguages?: string[];
}

