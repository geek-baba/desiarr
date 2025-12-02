import { describe, it, expect } from 'vitest';
import { parseReleaseFromTitle } from '../../../src/scoring/parseFromTitle';

describe('parseReleaseFromTitle', () => {
  // Note: parseReleaseFromTitle only extracts technical metadata (resolution, codec, source, audio, size, languages)
  // It does NOT extract movie name or year - that's done elsewhere in the codebase

  describe('Source detection', () => {
    it('should detect BLURAY source', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.BluRay.x264');
      expect(result.sourceTag).toBe('Bluray');
    });

    it('should detect DVD source', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.DVD.x264');
      expect(result.sourceTag).toBe('DVD');
    });

    it('should detect WEB-DL source', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.x264');
      expect(result.sourceTag).toBe('WEB-DL');
    });

    it('should detect WEBRIP source', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEBRIP.x264');
      expect(result.sourceTag).toBe('WEBRip');
    });

    it('should detect AMZN streaming service as source tag', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.AMZN.x264');
      // AMZN is detected as sourceTag when WEB-DL is not present
      expect(result.sourceTag).toBe('AMZN');
    });

    it('should prioritize WEB-DL over AMZN when both are present', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.AMZN.WEB-DL.x264');
      // WEB-DL comes first in pattern array, so it takes priority
      expect(result.sourceTag).toBe('WEB-DL');
    });

    it('should detect Netflix (NF) streaming service', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.NF.x264');
      expect(result.sourceTag).toBe('NF');
    });

    it('should prioritize WEB-DL over NF when both are present', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.NF.WEB-DL.x264');
      expect(result.sourceTag).toBe('WEB-DL');
    });

    it('should detect JioCinema (JC) streaming service', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.JC.x264');
      expect(result.sourceTag).toBe('JC');
    });

    it('should prioritize WEB-DL over JC when both are present', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.JC.WEB-DL.x264');
      expect(result.sourceTag).toBe('WEB-DL');
    });

    it('should detect Disney+ Hotstar (DSNP) streaming service', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.DSNP.x264');
      expect(result.sourceTag).toBe('DSNP');
    });

    it('should detect Disney+ Hotstar (HS) streaming service', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.HS.x264');
      expect(result.sourceTag).toBe('HS');
    });

    it('should detect ZEE5 streaming service', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.ZEE5.x264');
      expect(result.sourceTag).toBe('ZEE5');
    });

    it('should detect SS (likely SonyLIV) streaming service', () => {
      const result = parseReleaseFromTitle('Vallamai.2025.1080p.SS.DD+');
      expect(result.sourceTag).toBe('SS');
    });

    it('should prioritize WEB-DL over SS when both are present', () => {
      const result = parseReleaseFromTitle('Vallamai.2025.1080p.SS.WEB-DL.DD+');
      expect(result.sourceTag).toBe('WEB-DL');
    });
  });

  describe('Resolution detection', () => {
    it('should detect 1080p resolution', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL');
      expect(result.resolution).toBe('1080p');
    });

    it('should detect 720p resolution', () => {
      const result = parseReleaseFromTitle('Movie.2025.720p.WEB-DL');
      expect(result.resolution).toBe('720p');
    });

    it('should detect 2160p/4K resolution', () => {
      const result1 = parseReleaseFromTitle('Movie.2025.2160p.WEB-DL');
      expect(result1.resolution).toBe('2160p');

      const result2 = parseReleaseFromTitle('Movie.2025.4K.WEB-DL');
      expect(result2.resolution).toBe('2160p');
    });

    it('should default to UNKNOWN for missing resolution', () => {
      const result = parseReleaseFromTitle('Movie.2025.WEB-DL');
      expect(result.resolution).toBe('UNKNOWN');
    });
  });

  describe('Codec detection', () => {
    it('should detect x264 codec', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.x264');
      expect(result.codec).toBe('x264');
    });

    it('should detect x265/H.265/HEVC codec', () => {
      const result1 = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.x265');
      expect(result1.codec).toBe('x265');

      const result2 = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.H.264');
      expect(result2.codec).toBe('x264');

      const result3 = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.HEVC');
      expect(result3.codec).toBe('x265');
    });

    it('should default to UNKNOWN for missing codec', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL');
      expect(result.codec).toBe('UNKNOWN');
    });
  });

  describe('Audio detection', () => {
    it('should detect DDP 5.1 audio', () => {
      // Use format that matches the pattern: DD+ 5.1 or DDP5.1 (no space)
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.DD+5.1');
      expect(result.audio).toBe('DDP 5.1');
    });

    it('should detect DD+ audio', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.DD+');
      expect(result.audio).toBe('DDP');
    });

    it('should detect AC3 audio', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.AC3');
      expect(result.audio).toBe('DD');
    });

    it('should default to Unknown for unsupported audio formats like DTS', () => {
      // DTS is not in the audio patterns array, so it defaults to 'Unknown'
      const result = parseReleaseFromTitle('Movie.2025.1080p.BluRay.DTS');
      expect(result.audio).toBe('Unknown');
    });

    it('should default to Unknown for missing audio', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL');
      expect(result.audio).toBe('Unknown');
    });
  });

  describe('Size detection', () => {
    it('should detect size in GB', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.2.5GB');
      expect(result.sizeMb).toBe(2.5 * 1024);
    });

    it('should detect size in GiB', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.2.5GiB');
      expect(result.sizeMb).toBe(2.5 * 1024);
    });

    it('should detect size in MB', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.2500MB');
      expect(result.sizeMb).toBe(2500);
    });
  });

  describe('Language detection', () => {
    it('should detect Hindi language', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.Hindi');
      expect(result.audioLanguages).toContain('hi');
    });

    it('should detect Tamil language', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.Tamil');
      expect(result.audioLanguages).toContain('ta');
    });

    it('should detect multiple languages', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.WEB-DL.Hindi.Tamil');
      expect(result.audioLanguages).toContain('hi');
      expect(result.audioLanguages).toContain('ta');
    });
  });

  describe('Complex real-world examples', () => {
    it('should parse Vallamai release correctly', () => {
      const result = parseReleaseFromTitle('Vallamai 2025 1080p SS WEB-DL DD+ 5.1 H.264-DTR');
      expect(result.resolution).toBe('1080p');
      // WEB-DL takes priority over SS when both are present
      expect(result.sourceTag).toBe('WEB-DL');
      expect(result.audio).toBe('DDP 5.1');
      expect(result.codec).toBe('x264');
    });

    it('should parse Bas Ek Pal release correctly', () => {
      const result = parseReleaseFromTitle('Bas.Ek.Pal.2006.1080p.Ai.Upscale.DVD9.x264.00 5.1.ESub- Dano2008');
      expect(result.resolution).toBe('1080p');
      expect(result.sourceTag).toBe('DVD');
      expect(result.codec).toBe('x264');
    });

    it('should parse AMZN WEB-DL release correctly', () => {
      const result = parseReleaseFromTitle('Chowkidar Hi Chor Hai.2025.1080p.AMZN.WEB.DL.AVC.DDP.2.0.DUS');
      expect(result.resolution).toBe('1080p');
      // WEB-DL pattern matches "WEB.DL" and takes priority over AMZN
      expect(result.sourceTag).toBe('WEB-DL');
      expect(result.codec).toBe('x264');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      const result = parseReleaseFromTitle('');
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.sourceTag).toBe('OTHER');
      expect(result.codec).toBe('UNKNOWN');
      expect(result.audio).toBe('Unknown');
    });

    it('should handle title with no metadata', () => {
      const result = parseReleaseFromTitle('Just a Movie Title');
      expect(result.resolution).toBe('UNKNOWN');
      expect(result.sourceTag).toBe('OTHER');
      expect(result.codec).toBe('UNKNOWN');
      expect(result.audio).toBe('Unknown');
    });

    it('should handle case-insensitive patterns', () => {
      const result = parseReleaseFromTitle('Movie.2025.1080p.web-dl.x264');
      expect(result.sourceTag).toBe('WEB-DL');
      expect(result.codec).toBe('x264');
    });
  });
});
