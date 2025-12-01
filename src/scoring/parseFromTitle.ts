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
  // Physical media sources (check first as they're more specific)
  { pattern: /Blu[.\s-]?Ray|BDRip|BD\b/gi, value: 'Bluray' },
  { pattern: /DVD|DVDRip/gi, value: 'DVD' },
  // Web sources
  { pattern: /WEB[.\s-]?DL|WEB[.\s-]?DLRip/gi, value: 'WEB-DL' },
  { pattern: /WEBRip|WEB[.\s-]?Rip/gi, value: 'WEBRip' },
  // Streaming services
  { pattern: /AMZN|Amazon|Prime/gi, value: 'AMZN' },
  { pattern: /NF|Netflix/gi, value: 'NF' },
  { pattern: /JC|JioCinema/gi, value: 'JC' },
  { pattern: /ZEE5|Zee5/gi, value: 'ZEE5' },
  { pattern: /DSNP|Disney|Hotstar/gi, value: 'DSNP' },
  { pattern: /HS|Hotstar/gi, value: 'HS' },
  { pattern: /\bSS\b/gi, value: 'SS' }, // SS (likely SonyLIV or similar)
];

const audioPatterns = [
  { pattern: /DDP5\.1\s*Atmos|DD\+5\.1\s*Atmos|TrueHD\s*Atmos/gi, value: 'DDP 5.1 Atmos' },
  { pattern: /Atmos/gi, value: 'Atmos' },
  { pattern: /TrueHD/gi, value: 'TrueHD' },
  { pattern: /DD\+?\s*7\.1|DDP7\.1/gi, value: 'DDP 7.1' },
  { pattern: /DD\+?\s*5\.1|DDP5\.1|EAC3\s*5\.1/gi, value: 'DDP 5.1' }, // Match DD+ 5.1, DD+5.1, DDP5.1, EAC3 5.1
  { pattern: /DD\+?\s*2\.0|DDP2\.0|EAC3\s*2\.0/gi, value: 'DDP 2.0' }, // Match DD+ 2.0, DDP2.0, EAC3 2.0
  { pattern: /DD\+|DDP|EAC3/gi, value: 'DDP' }, // Generic DDP
  { pattern: /DD5\.1|AC3\s*5\.1/gi, value: 'DD 5.1' },
  { pattern: /DD2\.0|AC3\s*2\.0/gi, value: 'DD 2.0' },
  { pattern: /AC3|DD(?!P)/gi, value: 'DD' }, // AC3 or DD (but not DDP)
  { pattern: /AAC\s*5\.1/gi, value: 'AAC 5.1' },
  { pattern: /AAC\s*2\.0/gi, value: 'AAC 2.0' },
  { pattern: /AAC/gi, value: 'AAC' },
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

  // Parse resolution - test against original title (case-insensitive)
  let resolution: Resolution = 'UNKNOWN';
  for (const { pattern, value } of resolutionPatterns) {
    // Reset regex lastIndex to avoid issues with global regex
    pattern.lastIndex = 0;
    if (pattern.test(title)) {
      resolution = value;
      break;
    }
  }

  // Parse codec - test against original title
  let codec: Codec = 'UNKNOWN';
  for (const { pattern, value } of codecPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(title)) {
      codec = value;
      break;
    }
  }

  // Parse source tag - test against original title
  let sourceTag = 'OTHER';
  for (const { pattern, value } of sourcePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(title)) {
      sourceTag = value;
      break;
    }
  }

  // Parse audio - test against original title
  let audio = 'Unknown';
  for (const { pattern, value } of audioPatterns) {
    pattern.lastIndex = 0;
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

