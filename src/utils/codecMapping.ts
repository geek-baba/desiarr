// Audio codec mappings
export const audioCodecMap: { [key: string]: string } = {
  // EAC3 / DDP (Dolby Digital Plus)
  'EAC3': 'DDP',
  'E-AC-3': 'DDP',
  'DDP': 'DDP',
  'DD+': 'DDP',
  'DDP2.0': 'DDP 2.0',
  'DDP5.1': 'DDP 5.1',
  'DDP7.1': 'DDP 7.1',
  'DD+2.0': 'DDP 2.0',
  'DD+5.1': 'DDP 5.1',
  'DD+7.1': 'DDP 7.1',
  
  // AC3 / DD (Dolby Digital)
  'AC3': 'DD',
  'AC-3': 'DD',
  'DD': 'DD',
  'DD5.1': 'DD 5.1',
  'DD2.0': 'DD 2.0',
  
  // TrueHD
  'TrueHD': 'TrueHD',
  'TRUEHD': 'TrueHD',
  
  // Atmos
  'Atmos': 'Atmos',
  'ATMOS': 'Atmos',
  'DDP5.1Atmos': 'DDP 5.1 Atmos',
  'TrueHDAtmos': 'TrueHD Atmos',
  
  // AAC
  'AAC': 'AAC',
  'AAC2.0': 'AAC 2.0',
  'AAC5.1': 'AAC 5.1',
  
  // DTS
  'DTS': 'DTS',
  'DTS-HD': 'DTS-HD',
  'DTS-HD MA': 'DTS-HD MA',
  
  // PCM
  'PCM': 'PCM',
  'LPCM': 'LPCM',
  
  // MP3
  'MP3': 'MP3',
  
  // Opus
  'Opus': 'Opus',
  
  // Vorbis
  'Vorbis': 'Vorbis',
};

// Video codec mappings
export const videoCodecMap: { [key: string]: string } = {
  'H.264': 'x264',
  'H264': 'x264',
  'AVC': 'x264',
  'AVC1': 'x264',
  'x264': 'x264',
  
  'H.265': 'x265',
  'H265': 'x265',
  'HEVC': 'x265',
  'x265': 'x265',
  
  'VP9': 'VP9',
  'VP8': 'VP8',
  'AV1': 'AV1',
  
  'MPEG-2': 'MPEG-2',
  'MPEG2': 'MPEG-2',
  'MPEG-4': 'MPEG-4',
  'MPEG4': 'MPEG-4',
  
  'XviD': 'XviD',
  'DivX': 'DivX',
};

// Normalize audio codec name
export function normalizeAudioCodec(codec: string | undefined, channels?: number): string {
  if (!codec) return 'Unknown';
  
  const upper = codec.toUpperCase().trim();
  
  // Check direct mapping first
  if (audioCodecMap[upper]) {
    const mapped = audioCodecMap[upper];
    // Add channel info if available
    if (channels && (mapped === 'DDP' || mapped === 'DD' || mapped === 'AAC')) {
      if (channels === 2) return `${mapped} 2.0`;
      if (channels === 6) return `${mapped} 5.1`;
      if (channels === 8) return `${mapped} 7.1`;
    }
    return mapped;
  }
  
  // Pattern matching
  if (upper.includes('EAC3') || upper.includes('E-AC-3') || upper.includes('DDP') || upper.includes('DD+')) {
    if (channels === 2) return 'DDP 2.0';
    if (channels === 6) return 'DDP 5.1';
    if (channels === 8) return 'DDP 7.1';
    return 'DDP';
  }
  
  if (upper.includes('AC3') || upper.includes('AC-3') || (upper.includes('DD') && !upper.includes('DDP'))) {
    if (channels === 2) return 'DD 2.0';
    if (channels === 6) return 'DD 5.1';
    return 'DD';
  }
  
  if (upper.includes('TRUEHD')) return 'TrueHD';
  if (upper.includes('ATMOS')) return 'Atmos';
  if (upper.includes('AAC')) {
    if (channels === 2) return 'AAC 2.0';
    if (channels === 6) return 'AAC 5.1';
    return 'AAC';
  }
  if (upper.includes('DTS')) return 'DTS';
  if (upper.includes('PCM') || upper.includes('LPCM')) return 'PCM';
  
  return codec; // Return original if no match
}

// Normalize video codec name
export function normalizeVideoCodec(codec: string | undefined): string {
  if (!codec) return 'UNKNOWN';
  
  const upper = codec.toUpperCase().trim();
  
  // Check direct mapping
  if (videoCodecMap[upper]) {
    return videoCodecMap[upper];
  }
  
  // Pattern matching
  if (upper.includes('264') || upper.includes('AVC') || upper.includes('H.264')) return 'x264';
  if (upper.includes('265') || upper.includes('HEVC') || upper.includes('H.265')) return 'x265';
  if (upper.includes('VP9')) return 'VP9';
  if (upper.includes('VP8')) return 'VP8';
  if (upper.includes('AV1')) return 'AV1';
  
  return codec; // Return original if no match
}

