import { parseReleaseFromTitle, normalizeTitle } from '../scoring/parseFromTitle';
import { ParsedRelease } from '../types/QualitySettings';

export interface RSSItem {
  title: string;
  link: string;
  guid: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
  description?: string;
}

function sanitizeTitle(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRSSItem(item: RSSItem, feedId: number, sourceSite: string) {
  const title = item.title || item.link || 'Unknown';
  const parsed = parseReleaseFromTitle(title);
  const normalized = normalizeTitle(title);
  const sanitizedTitle = sanitizeTitle(title);

  // Try to extract year from title
  const yearMatchForExtraction = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatchForExtraction ? parseInt(yearMatchForExtraction[0], 10) : undefined;

  // Try to extract TMDB ID and IMDB ID from description/content
  let tmdbId: number | undefined;
  let imdbId: string | undefined;
  const description = item.description || item.content || item.contentSnippet || '';
  let publishedAt = item.pubDate;
  const addedMatch = description.match(/Added:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/i);
  if (addedMatch) {
    const addedString = addedMatch[1].trim().replace(' ', 'T');
    const addedDate = new Date(`${addedString}Z`);
    if (!isNaN(addedDate.getTime())) {
      publishedAt = addedDate.toISOString();
    }
  }
  if (!publishedAt) {
    publishedAt = new Date().toISOString();
  }
  
  // Try multiple patterns to find TMDB ID
  // Be strict: only match actual TMDB movie page URLs or explicit "TMDB ID:" patterns
  // IMPORTANT: Exclude image.tmdb.org URLs (they contain image hashes, not movie IDs)
  // Avoid matching random numbers that happen to be after "TMDB"
  
  // First, try to match actual movie page URLs (most reliable)
  let tmdbMatch = description.match(/themoviedb\.org\/movie\/(\d+)/i);
  
  // If no movie URL found, try explicit ID patterns (but NOT in image URLs)
  if (!tmdbMatch) {
    // Match "TMDB ID: 12345" or "TMDB: 12345" but NOT in image URLs
    tmdbMatch = description.match(/(?<!image\.)tmdb\s+id\s*[:\-]?\s*(\d+)/i) ||
                description.match(/tmdb\s+link[:\s]+.*?(\d+)/i) ||
                description.match(/(?<!image\.)tmdb[:\s]+(\d+)/i);
  }
  
  if (tmdbMatch) {
    const extractedId = parseInt(tmdbMatch[1], 10);
    // Validate: TMDB IDs are typically 4-8 digits, but be reasonable
    // Also log a warning if the ID seems suspicious (very low numbers might be old/incorrect)
    if (extractedId > 0 && extractedId < 100000000) {
      // Double-check: make sure we didn't match from an image URL
      const matchIndex = tmdbMatch.index || 0;
      const beforeMatch = description.substring(Math.max(0, matchIndex - 50), matchIndex);
      if (!beforeMatch.includes('image.tmdb.org') && !beforeMatch.includes('image.tmdb')) {
        tmdbId = extractedId;
        console.log(`  Extracted TMDB ID ${tmdbId} from RSS feed for: ${title}`);
        if (extractedId < 10000) {
          console.log(`  ⚠ WARNING: TMDB ID ${tmdbId} seems unusually low - may be incorrect`);
        }
      } else {
        console.log(`  ⚠ Ignored TMDB ID ${extractedId} - matched from image URL, not movie page`);
      }
    } else {
      console.log(`  ⚠ Ignored invalid TMDB ID ${extractedId} from RSS feed (out of range)`);
    }
  }
  
  // Try to extract IMDB ID from description
  const imdbMatch = description.match(/imdb\.com\/title\/(tt\d{7,})/i) ||
                    description.match(/IMDB\s+Link.*?(tt\d{7,})/i) ||
                    description.match(/IMDB.*?(tt\d{7,})/i);
  if (imdbMatch) {
    imdbId = imdbMatch[1];
    console.log(`  Extracted IMDB ID ${imdbId} from RSS feed for: ${title}`);
  } else {
    const imdbFallback = description.match(/(tt\d{7,})/i);
    if (imdbFallback) {
      imdbId = imdbFallback[1];
      console.log(`  Extracted IMDB ID (fallback) ${imdbId} from RSS feed for: ${title}`);
    }
  }

  // Try to extract size from description (RSS feeds often have size in description)
  let sizeMb: number | undefined = parsed.sizeMb;
  if (!sizeMb && description) {
    // Look for size patterns in description like "Size: 3.16 GiB" or "3.52 GiB"
    // Try "Size:" pattern first, then general pattern
    const sizeMatch = description.match(/<strong>Size<\/strong>:\s*(\d+(?:\.\d+)?)\s*(GB|MB|GiB|MiB)/i) ||
                      description.match(/Size[:\s]+(\d+(?:\.\d+)?)\s*(GB|MB|GiB|MiB)/i) ||
                      description.match(/(\d+(?:\.\d+)?)\s*(GB|MB|GiB|MiB)/i);
    if (sizeMatch) {
      const sizeValue = parseFloat(sizeMatch[1]);
      const unit = sizeMatch[2].toUpperCase();
      if (unit.includes('GB') || unit.includes('GIB')) {
        sizeMb = sizeValue * 1024;
      } else {
        sizeMb = sizeValue;
      }
      console.log(`  Extracted size ${sizeMb.toFixed(2)} MB from RSS feed for: ${title}`);
    }
  }

  // Extract clean movie title (remove quality info, year, etc.)
  // Strategy: Find year (including in parentheses), discard everything after it
  // Example: "X.and.Y.(2025).2160p..." -> "X and Y"
  // Example: "Uruttu Uruttu 2025 1080p..." -> "Uruttu Uruttu"
  
  // First, replace dots and hyphens with spaces for easier matching
  let cleanTitle = sanitizedTitle.replace(/[._-]+/g, ' ');
  
  // Find the year position - can be in format: (2025), 2025, or just digits
  // Try to find year in parentheses first, then standalone year
  let yearMatch = cleanTitle.match(/\s*\([^)]*(19|20)\d{2}[^)]*\)/i);
  let yearIndex: number | undefined;
  
  if (yearMatch && yearMatch.index !== undefined) {
    // Found year in parentheses - extract everything before the opening parenthesis
    yearIndex = yearMatch.index;
  } else {
    // Try to find standalone year
    yearMatch = cleanTitle.match(/\b(19|20)\d{2}\b/);
    if (yearMatch && yearMatch.index !== undefined) {
      yearIndex = yearMatch.index;
    }
  }
  
  if (yearIndex !== undefined) {
    // Extract everything before the year (including parentheses if found)
    cleanTitle = cleanTitle.substring(0, yearIndex).trim();
  } else {
    // No year found, remove quality patterns instead as fallback
    // Remove quality/resolution patterns (2160p, 1080p, etc.)
    cleanTitle = cleanTitle.replace(/\b(2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd)\b/gi, '');
    
    // Remove codec patterns
    cleanTitle = cleanTitle.replace(/\b(x264|x265|h264|h265|hevc|avc|h\.?264|h\.?265)\b/gi, '');
    
    // Remove source tags and quality indicators
    cleanTitle = cleanTitle.replace(/\b(amzn|netflix|nf|jc|jiocinema|zee5|dsnp|disney|hotstar|hs|ss|web[- ]?dl|webdl|webrip|bluray|dvdrip|dus|dtr|khn)\b/gi, '');
    
    // Remove audio patterns
    cleanTitle = cleanTitle.replace(/\b(dd\+?|ddp|eac3|ac3|atmos|truehd|dts|aac|stereo|5\s*\.?\s*1|7\s*\.?\s*1|2\s*\.?\s*0)\b/gi, '');
    
    // Remove common release group patterns
    cleanTitle = cleanTitle.replace(/\b([a-z]{2,4}(?:[-_][a-z]{2,4})?)\b/gi, '');
    
    // Remove any remaining numbers that might be part of quality info
    cleanTitle = cleanTitle.replace(/\b\d{3,}\b/g, '');
  }
  
  // Remove any remaining parenthetical info at the end (shouldn't happen if year was found, but just in case)
  cleanTitle = cleanTitle.replace(/\s*\(.*?\)\s*$/, '');
  
  // Remove standalone hyphens and dashes
  cleanTitle = cleanTitle.replace(/\s*[-–—]\s*/g, ' ');
  
  // Normalize "and" to "&" for better matching (e.g., "x and y" -> "x & y")
  // This helps match titles like "X & Y" in TMDB
  cleanTitle = cleanTitle.replace(/\s+and\s+/gi, ' & ');
  
  // Clean up extra whitespace and trim
  cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();
  
  // Remove trailing hyphens, dashes, or other punctuation
  cleanTitle = cleanTitle.replace(/[-–—\s]+$/, '').trim();

  return {
    guid: item.guid || item.link,
    title: title,
    clean_title: cleanTitle, // Clean title for searching
    normalized_title: normalized,
    year,
    tmdb_id: tmdbId,
    imdb_id: imdbId, // Add IMDB ID from RSS feed
    source_site: sourceSite,
    feed_id: feedId,
    link: item.link,
    resolution: parsed.resolution,
    source_tag: parsed.sourceTag,
    codec: parsed.codec,
    audio: parsed.audio,
    rss_size_mb: sizeMb || parsed.sizeMb,
    published_at: publishedAt,
    audio_languages: parsed.audioLanguages ? JSON.stringify(parsed.audioLanguages) : undefined,
    parsed,
  };
}

