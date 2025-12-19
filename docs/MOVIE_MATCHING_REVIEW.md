# Movie Matching Review - BWT Movies Feed

## Current Flow When RSS Items Have No IDs

### 1. RSS Sync Phase (`rssSync.ts`)

**Steps:**
1. Extract IDs from RSS description (TMDB URLs, IMDB links)
2. Generate `clean_title` from title (removes quality info, year, etc.)
3. Search TMDB with `clean_title` + year
4. If no match, try `normalized_title` + year
5. If still no match, try Brave Search
6. If still no match, try IMDB/OMDB search

**Issues Identified:**

#### A. Title Cleaning (`parseRelease.ts` lines 121-183)
- **Problem**: Complex extraction logic that may fail for BWT Movies
  - Removes everything after year (line 147)
  - If year is wrong/missing, falls back to aggressive pattern removal
  - May remove important title words

**Example Issues:**
- `"Premachi Gosht 2 2025 1080p..."` → `"Premachi Gosht 2"` ✓ (good)
- `"Movie Name 2024 1080p..."` → `"Movie Name"` ✓ (good)
- `"Movie Name 1080p 2024..."` → `"Movie Name"` ✗ (year after quality, might not extract correctly)
- `"Movie Name Without Year 1080p..."` → aggressive cleanup might remove words

#### B. TMDB Search Logic (`rssSync.ts` lines 217-250, `matchingEngine.ts` lines 358-402)
- **Problem**: Takes first result without validation
  - Only validates year (exact match required)
  - No title similarity check
  - No confidence scoring
  - No handling of regional language titles

**Current Code:**
```typescript
const tmdbMovie = await tmdbClient.searchMovie(cleanTitle, year || undefined);
if (tmdbMovie) {
  // Only checks year match, no title similarity
  if (year && tmdbMovie.release_date) {
    const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
    if (releaseYear !== year) {
      isValidMatch = false; // Rejects if year doesn't match
    }
  }
  // Uses first result regardless of title similarity
}
```

**Issues:**
1. **No Title Similarity**: If TMDB returns "Movie A" but RSS has "Movie B", it still matches if year matches
2. **Year Too Strict**: Exact year match required - if year is wrong in RSS, correct match is rejected
3. **No Multiple Results**: TMDB API returns multiple results, but only first is considered
4. **No Regional Language Handling**: BWT Movies often have regional titles that don't match English TMDB titles

### 2. Matching Engine Phase (`matchingEngine.ts`)

**Steps:**
1. Validate existing TMDB/IMDB pair (if both exist)
2. If TMDB ID exists, extract IMDB from TMDB
3. If IMDB exists but no TMDB, get TMDB from IMDB
4. If no TMDB ID, search TMDB with `clean_title` + year
5. If still no TMDB ID, search IMDB/OMDB

**Issues:**
- Same problems as RSS Sync phase
- No additional validation beyond year check
- No fuzzy matching or similarity scoring

## Root Causes of Inaccurate Matches

### 1. **Title Cleaning Too Aggressive**
- Removes important words when year is missing
- Pattern removal might remove part of actual title
- No BWT-specific handling (unlike TV shows)

### 2. **No Title Similarity Validation**
- Accepts first TMDB result if year matches
- Doesn't check if titles are actually similar
- Example: RSS "Movie A 2024" might match TMDB "Movie B 2024" if year matches

### 3. **Year Validation Too Strict**
- Exact year match required
- If RSS has wrong year, correct match is rejected
- No tolerance for year variations (e.g., 2024 vs 2025)

### 4. **No Multiple Results Consideration**
- TMDB search returns array, but only first result used
- Better match might be in results[1] or results[2]
- No scoring/ranking of results

### 5. **No Regional Language Support**
- BWT Movies often have regional titles
- TMDB search in English might not find regional movies
- No fallback to search by original language

### 6. **No Confidence Scoring**
- All matches treated equally
- No way to reject low-confidence matches
- No threshold for "good enough" matches

## Recommendations

### 1. **Improve Title Cleaning**
- Add BWT-specific handling (similar to BWT TVShows)
- More conservative pattern removal
- Better year detection (handle year at end of title)
- Preserve more of the original title

### 2. **Add Title Similarity Validation**
- Use string similarity (Levenshtein, Jaro-Winkler)
- Compare `clean_title` with TMDB result title
- Reject matches below similarity threshold (e.g., < 0.7)

### 3. **Consider Multiple TMDB Results**
- Evaluate top 3-5 results
- Score each result based on:
  - Title similarity
  - Year match (with tolerance)
  - Popularity/relevance
- Select best match, not just first

### 4. **Relax Year Validation**
- Allow ±1 year tolerance
- Weight year match but don't reject on mismatch alone
- Use year as tiebreaker, not hard requirement

### 5. **Add Regional Language Support**
- Try searching with original title first
- Fallback to English search
- Consider TMDB's `original_title` field

### 6. **Add Confidence Scoring**
- Score each match (0-1)
- Only accept matches above threshold (e.g., 0.6)
- Mark low-confidence matches for manual review

### 7. **Better Logging**
- Log all TMDB search results
- Log similarity scores
- Log why matches were accepted/rejected

## Example Improved Flow

```typescript
// 1. Search TMDB
const tmdbResults = await tmdbClient.searchMovies(cleanTitle, year, 5); // Get top 5

// 2. Score each result
const scoredResults = tmdbResults.map(result => ({
  movie: result,
  score: calculateMatchScore(cleanTitle, year, result)
})).filter(r => r.score >= MIN_CONFIDENCE_THRESHOLD);

// 3. Select best match
if (scoredResults.length > 0) {
  const bestMatch = scoredResults.sort((a, b) => b.score - a.score)[0];
  tmdbId = bestMatch.movie.id;
  console.log(`✓ Matched with confidence ${bestMatch.score.toFixed(2)}`);
} else {
  console.log(`✗ No confident matches found`);
}

function calculateMatchScore(cleanTitle: string, year: number | undefined, tmdbMovie: any): number {
  let score = 0;
  
  // Title similarity (0-0.6)
  const titleSimilarity = stringSimilarity(cleanTitle, tmdbMovie.title);
  score += titleSimilarity * 0.6;
  
  // Year match (0-0.3)
  if (year && tmdbMovie.release_date) {
    const releaseYear = new Date(tmdbMovie.release_date).getFullYear();
    const yearDiff = Math.abs(releaseYear - year);
    if (yearDiff === 0) score += 0.3;
    else if (yearDiff === 1) score += 0.15; // ±1 year tolerance
  }
  
  // Popularity/relevance (0-0.1)
  score += Math.min(tmdbMovie.popularity / 100, 0.1);
  
  return Math.min(score, 1.0);
}
```

## Next Steps

1. **Immediate**: Add title similarity validation to existing search
2. **Short-term**: Consider multiple TMDB results
3. **Medium-term**: Add confidence scoring system
4. **Long-term**: Add regional language support

