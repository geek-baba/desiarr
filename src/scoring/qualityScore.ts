import { ParsedRelease, QualitySettings } from '../types/QualitySettings';

export function isReleaseAllowed(parsed: ParsedRelease, settings: QualitySettings): boolean {
  const resolutionRule = settings.resolutions.find((r) => r.resolution === parsed.resolution);
  
  if (!resolutionRule || !resolutionRule.allowed) {
    return false;
  }

  // Check discouraged codecs
  if (resolutionRule.discouragedCodecs && resolutionRule.discouragedCodecs.length > 0) {
    if (resolutionRule.discouragedCodecs.includes(parsed.codec)) {
      return false;
    }
  }

  return true;
}

export function computeQualityScore(
  parsed: ParsedRelease,
  settings: QualitySettings,
  options: { isDubbed?: boolean; preferredLanguage?: boolean } = {}
): number {
  let score = 0;

  // Resolution weight
  score += settings.resolutionWeights[parsed.resolution] || 0;

  // Source tag weight
  score += settings.sourceTagWeights[parsed.sourceTag] || 0;

  // Codec weight
  score += settings.codecWeights[parsed.codec] || 0;

  // Audio weight
  for (const [pattern, weight] of Object.entries(settings.audioWeights)) {
    if (parsed.audio.toLowerCase().includes(pattern.toLowerCase())) {
      score += weight;
      break;
    }
  }

  // Preferred codec bonus
  const resolutionRule = settings.resolutions.find((r) => r.resolution === parsed.resolution);
  if (resolutionRule?.preferredCodecs?.includes(parsed.codec)) {
    score += 10;
  }

  // Discouraged codec penalty
  if (resolutionRule?.discouragedCodecs?.includes(parsed.codec)) {
    score -= 15;
  }

  // Size bonus
  if (settings.sizeBonusEnabled && parsed.sizeMb) {
    // Bonus based on size (larger files generally better quality)
    // Scale: 1GB = 10 points, 2GB = 20 points, etc.
    const sizeBonus = Math.min(parsed.sizeMb / 100, 30); // Cap at 30 points
    score += sizeBonus;
  }

  // Preferred language bonus
  if (options.preferredLanguage) {
    score += settings.preferredLanguageBonus;
  }

  // Dubbed penalty
  if (options.isDubbed) {
    score += settings.dubbedPenalty;
  }

  return Math.round(score * 100) / 100; // Round to 2 decimal places
}

