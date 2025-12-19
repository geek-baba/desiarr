# TMDB Search Bug Explanation - "Kona" vs "Vesimağa Konağı"

## The Problem

When searching for "Kona" (2025), the app matched it to "Vesimağa Konağı" (2025) instead of "Kona" (2025).

## Root Cause

The `searchMovie()` function in `src/tmdb/client.ts` uses `find()` to get the first result that matches the year:

```typescript
const yearMatch = response.data.results.find(movie => {
  const releaseYear = new Date(movie.release_date).getFullYear();
  return releaseYear === year;  // Returns FIRST match
});
```

**The Issue:**
- `find()` returns the **first** result in the array that matches the year
- TMDB's result order can change (based on popularity, relevance, new data)
- If "Vesimağa Konağı" appears before "Kona" in the results, it gets selected
- **No title similarity check** - just takes first year match

## Example Scenario

### When RSS was processed (wrong match):
```
TMDB Results Order:
[1] "Vesimağa Konağı" (2025) ← find() returns this (first with year 2025)
[2] "Kona" (2025)             ← Better match, but ignored
[3] "Mission: Impossible" (2025)
```

### Current test (correct match):
```
TMDB Results Order:
[1] "Kona" (2025)             ← find() returns this (first with year 2025) ✅
[2] "Vesimağa Konağı" (2025)
[3] "Mission: Impossible" (2025)
```

## Why Results Order Changes

TMDB's search API returns results sorted by:
- Relevance score
- Popularity
- Release date
- New data added to TMDB

This means the order can change over time, causing inconsistent matches.

## The Fix Needed

Instead of using `find()` to get the first year match, we should:

1. **Get all results** that match the year
2. **Score each result** by:
   - Title similarity (most important)
   - Original title similarity
   - Popularity/relevance
3. **Select the best match**, not just the first

## Code Change Required

```typescript
// Current (WRONG):
const yearMatch = response.data.results.find(movie => {
  return releaseYear === year;
});
return yearMatch;  // First match, not best match

// Should be (CORRECT):
const yearMatches = response.data.results
  .filter(movie => {
    const releaseYear = new Date(movie.release_date).getFullYear();
    return releaseYear === year;
  })
  .map(movie => ({
    movie,
    score: calculateSimilarityScore(query, movie)
  }))
  .sort((a, b) => b.score - a.score);

return yearMatches[0]?.movie;  // Best match, not first match
```

