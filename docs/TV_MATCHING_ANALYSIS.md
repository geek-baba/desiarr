# TV Show Matching Analysis - "Kurukshetra" vs "She (2020)"

## The Problem

RSS Item: `"Kurukshetra The Great War of Mahabharata S01 1080p NF WEB-DL MULTi DD+ 5.1 H.264-DTR"`
Incorrectly matched to: `"She (2020)"`

## Current TV Matching Flow

### Step 1: Title Parsing
- Input: `"Kurukshetra The Great War of Mahabharata S01 1080p NF WEB-DL MULTi DD+ 5.1 H.264-DTR"`
- Parsed: `showName = "Kurukshetra The Great War of Mahabharata"`, `season = 1`, `year = null`

### Step 2: TVDB Search (Primary)
**Code:** `src/services/tvMatchingEngine.ts` lines 135-202

```typescript
const tvdbResults = await tvdbClient.searchSeries(showName);
if (tvdbResults && tvdbResults.length > 0) {
  // Take the first result (best match) ← PROBLEM: No validation!
  const tvdbShow = tvdbResults[0];
  tvdbId = tvdbShow.tvdb_id || tvdbShow.id;
  
  // Get extended info
  const tvdbExtended = await tvdbClient.getSeriesExtended(tvdbId);
  // Extract TMDB ID from remoteIds
  const tmdbRemote = remoteIds.find(...);
  if (tmdbRemote) {
    tmdbId = tmdbRemote.id; // ✅ Correctly extracted
  }
}
```

**What Actually Happens:**
- TVDB search for "Kurukshetra The Great War of Mahabharata" returns:
  - [1] "कुरूक्षेत्र" (TVDB ID: 468042) ✅ Correct
- TVDB extended info has TMDB ID: 300894 ✅ Correct
- **This should work correctly now** (after the remoteIds fix)

### Step 3: TMDB Search (Fallback - THE PROBLEM)
**Code:** `src/services/tvMatchingEngine.ts` lines 204-226

```typescript
// Step 2: If TMDB ID not found, search TMDB directly
if (!tmdbId && tmdbApiKey) {
  const tmdbResults = await tmdbClient.searchTv(showName);
  if (tmdbResults && tmdbResults.length > 0) {
    tmdbId = tmdbResults[0].id; // ← PROBLEM: Takes first result, no validation!
    console.log(`    ✓ Found TMDB ID: ${tmdbId}`);
  }
}
```

**The Bug:**
- Uses `tmdbResults[0].id` - **takes first result without validation**
- No title similarity check
- No language validation
- No scoring or ranking

**What Could Happen:**
1. If TVDB search fails or doesn't return TMDB ID (before the fix)
2. Falls back to TMDB search
3. TMDB might return results in wrong order
4. Takes first result regardless of title similarity
5. Could match to "She" if it appears first

## Root Causes

### 1. **TVDB Search Uses First Result**
- Line 142: `const tvdbShow = tvdbResults[0];`
- No validation that the first result is actually the best match
- If TVDB returns results in wrong order, wrong show is selected

### 2. **TMDB Fallback Uses First Result**
- Line 210: `tmdbId = tmdbResults[0].id;`
- Same bug as movies had - no scoring or validation
- **This is the same issue we just fixed for movies!**

### 3. **No Title Similarity Validation**
- Unlike movies (which we just fixed), TV shows don't have title similarity scoring
- No way to reject incorrect matches

### 4. **No Language Support**
- TV shows don't extract or use language information
- Can't prefer regional language matches

## Why "She (2020)" Was Selected

Possible scenarios:

1. **TVDB search failed** (before remoteIds fix)
   - TVDB didn't return TMDB ID
   - Fell back to TMDB search
   - TMDB returned "She" as first result
   - Code selected it without validation

2. **TVDB returned wrong first result**
   - TVDB search might have returned "She" first
   - Code takes first result without validation
   - Wrong show selected

3. **TMDB search order issue**
   - TMDB search for "Kurukshetra The Great War of Mahabharata"
   - TMDB might return "She" first (if search is ambiguous)
   - Code takes first result

## The Fix Needed

Apply the same improvements we made for movies:

1. **Add title similarity scoring for TV shows**
   - Score TVDB results by title similarity
   - Score TMDB results by title similarity
   - Select best match, not first match

2. **Add language support for TV shows**
   - Extract language from RSS items (similar to movies)
   - Use language as scoring factor

3. **Improve TVDB result selection**
   - Don't just take first result
   - Score and rank results

4. **Improve TMDB fallback**
   - Use same scoring system as movies
   - Don't just take first result

## Code Locations to Fix

1. `src/services/tvMatchingEngine.ts`:
   - Line 142: TVDB first result selection
   - Line 210: TMDB first result selection
   - Add title similarity scoring
   - Add language extraction and scoring

2. `src/tmdb/client.ts`:
   - `searchTv()` function - add scoring like `searchMovie()`

