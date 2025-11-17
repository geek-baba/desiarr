import { ParsedRelease, Resolution, Codec } from '../types/QualitySettings';

const resolutionPatterns = [
  { pattern: /2160[pi]|4K|UHD/gi, value: '2160p' as Resolution },
  { pattern: /1080[pi]|FHD/gi, value: '1080p' as Resolution },
  { pattern: /720[pi]|HD/gi, value: '720p' as Resolution },
  { pattern: /480[pi]|SD/gi, value: '480p' as Resolution },
];

const codecPatterns = [
  { pattern: /x265|HEVC|H\.?265/gi, value: 'x265' as Codec },
  { pattern: /x264|AVC|H\.?264/gi, value: 'x264' as Codec },
];

const sourcePatterns = [
  { pattern: /AMZN|Amazon|Prime/gi, value: 'AMZN' },
  { pattern: /NF|Netflix/gi, value: 'NF' },
  { pattern: /JC|JioCinema/gi, value: 'JC' },
  { pattern: /ZEE5|Zee5/gi, value: 'ZEE5' },
  { pattern: /DSNP|Disney|Hotstar/gi, value: 'DSNP' },
  { pattern: /HS|Hotstar/gi, value: 'HS' },
];

const audioPatterns = [
  { pattern: /Atmos/gi, value: 'Atmos' },
  { pattern: /TrueHD/gi, value: 'TrueHD' },
  { pattern: /DDP5\.1|DD\+5\.1|EAC3/gi, value: 'DDP5.1' },
  { pattern: /DD5\.1|AC3/gi, value: 'DD5.1' },
  { pattern: /2\.0|Stereo/gi, value: '2.0' },
];

const languagePatterns = [
  { pattern: /Hindi|हिंदी/gi, code: 'hi' },
  { pattern: /Telugu|తెలుగు/gi, code: 'te' },
  { pattern: /Tamil|தமிழ்/gi, code: 'ta' },
  { pattern: /Kannada|ಕನ್ನಡ/gi, code: 'kn' },
  { pattern: /Malayalam|മലയാളം/gi, code: 'ml' },
  { pattern: /English/gi, code: 'en' },
];

const sizePattern = /(\d+(?:\.\d+)?)\s*(?:GB|MB|GiB|MiB)/gi;

export function parseReleaseFromTitle(title: string): ParsedRelease {
  const normalized = title.toUpperCase();

  // Parse resolution
  let resolution: Resolution = 'UNKNOWN';
  for (const { pattern, value } of resolutionPatterns) {
    if (pattern.test(title)) {
      resolution = value;
      break;
    }
  }

  // Parse codec
  let codec: Codec = 'UNKNOWN';
  for (const { pattern, value } of codecPatterns) {
    if (pattern.test(title)) {
      codec = value;
      break;
    }
  }

  // Parse source tag
  let sourceTag = 'OTHER';
  for (const { pattern, value } of sourcePatterns) {
    if (pattern.test(title)) {
      sourceTag = value;
      break;
    }
  }

  // Parse audio
  let audio = 'Unknown';
  for (const { pattern, value } of audioPatterns) {
    if (pattern.test(title)) {
      audio = value;
      break;
    }
  }

  // Parse size
  let sizeMb: number | undefined;
  const sizeMatch = title.match(sizePattern);
  if (sizeMatch) {
    const sizeStr = sizeMatch[0];
    const sizeValue = parseFloat(sizeStr);
    if (sizeStr.toUpperCase().includes('GB') || sizeStr.toUpperCase().includes('GIB')) {
      sizeMb = sizeValue * 1024;
    } else {
      sizeMb = sizeValue;
    }
  }

  // Parse languages
  const audioLanguages: string[] = [];
  for (const { pattern, code } of languagePatterns) {
    if (pattern.test(title)) {
      if (!audioLanguages.includes(code)) {
        audioLanguages.push(code);
      }
    }
  }

  return {
    resolution,
    sourceTag,
    codec,
    audio,
    sizeMb,
    audioLanguages: audioLanguages.length > 0 ? audioLanguages : undefined,
  };
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

