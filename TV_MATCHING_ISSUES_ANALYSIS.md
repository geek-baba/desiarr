# TV Show Matching Issues - Analysis Report

## Summary
This document analyzes the TV show matching issues found in the dashboard screenshots. The analysis reveals several critical problems in the matching logic.

---

## Issue 1: "Azad" → "Le Mille E Una Notte - Aladino E Sherazade" (WRONG MATCH)

### Problem
- **RSS Title**: `Azad.2025.S01.1080p.AMZN.WeB.DL.AVC.DDP.2.0.Dus`
- **Parsed Show Name**: Should be "Azad" but matched to "Le Mille E Una Notte - Aladino E Sherazade"
- **TVDB ID**: 264497 (WRONG - this is for "Le Mille E Una Notte")
- **TMDB ID**: 75557 (WRONG - this is for "One Thousand and One Nights")
- **IMDB ID**: tt0424604 (WRONG - should be tt2323894 based on TVDB/TMDB)

### Root Cause Analysis
1. **Title Parsing Issue**: The `parseTvTitle()` function extracts "Azad" from "Azad.2025.S01..." correctly
2. **TVDB Search Problem**: When searching TVDB for "Azad", it's likely returning "Le Mille E Una Notte" as the best match (similarity scoring issue)
3. **ID Mismatch**: The IMDB ID stored (tt0424604) doesn't match what TVDB/TMDB say (tt2323894), indicating the IDs were pulled from a different source or manually set incorrectly

### Evidence
- TVDB ID 264497 = "Le Mille E Una Notte - Aladino E Sherazade" (2012)
- TMDB ID 75557 = "One Thousand and One Nights" (2012) - matches TVDB
- But stored IMDB ID tt0424604 doesn't match TMDB's tt2323894

### Impact
**CRITICAL**: Completely wrong show matched. "Azad" is a different show entirely.

---

## Issue 2: "Rise and Fall" → "Fall (2022)" (WRONG TMDB ID)

### Problem
- **RSS Title**: `Rise And Fall.2025.S01.1080p.AMZN.WEB.DL.AVC.DDP.2.0.DUS`
- **Parsed Show Name**: "Rise and Fall" (correct)
- **TVDB ID**: NULL (missing)
- **TMDB ID**: 300081 (MANUAL - WRONG)
- **IMDB ID**: tt1071791 (WRONG - should be tt35674433)
- **Sonarr Title**: "Fall (2022)" (different show!)

### Root Cause Analysis
1. **TMDB ID Mismatch**: TMDB ID 300081 is for "Rise and Fall" (2025, Hindi), but:
   - Stored IMDB ID tt1071791 doesn't match TMDB's tt35674433
   - This suggests the TMDB ID was manually set incorrectly
2. **TVDB ID Missing**: No TVDB ID was found, which is the primary source for TV shows
3. **Sonarr Title Mismatch**: Sonarr shows "Fall (2022)" which is a completely different show, suggesting:
   - Either the TMDB ID 300081 is wrong
   - Or Sonarr has a different show with the same TMDB ID
   - Or the show was added to Sonarr with wrong IDs

### Evidence
- TMDB ID 300081 = "Rise and Fall" (2025, Hindi, IMDB: tt35674433)
- But stored IMDB ID is tt1071791 (which is for "Fall" 2022 movie, not TV show)
- TVDB ID is NULL, so we can't verify the correct match

### Impact
**HIGH**: Wrong TMDB ID manually set, causing incorrect matching and Sonarr sync issues.

---

## Issue 3: "Scam 1992" (Mostly Correct, but Display Issue)

### Problem
- **RSS Title**: `Scam.1992.The.Harshad.Mehta.Story.(2020).2160p.Multi.WEB-DL...`
- **Parsed Show Name**: "Scam 1992: The Harshad Mehta Story" / "Scam 1992 - The Harshad Mehta Story"
- **TVDB ID**: 389680 ✅ (CORRECT)
- **TMDB ID**: 111188 ✅ (CORRECT)
- **IMDB ID**: tt12392504 ✅ (CORRECT)
- **Sonarr Title**: "Scam 1992 - The Harshad Mehta Story" (one shows "16" which is weird)

### Root Cause Analysis
1. **IDs are Correct**: All IDs match between TVDB and TMDB
2. **Display Issue**: One release shows Sonarr Title as "16" instead of the show name
   - This is likely a data corruption or display bug
   - The `sonarr_series_title` field might have been incorrectly set

### Evidence
- TVDB ID 389680 = "Scam 1992 - The Harshad Mehta Story" ✅
- TMDB ID 111188 = "Scam 1992: The Harshad Mehta Story" ✅
- IMDB ID tt12392504 matches both ✅

### Impact
**LOW**: IDs are correct, just a display/data issue with one release.

---

## Issue 4: "90's A Middle Class Biopic" → "Class (2023)" (WRONG MATCH)

### Problem
- **RSS Title**: `90's A Middle Class Biopic S01 1080p NF WEB-DL MULTi DD+ 5.1 H.264-DTR`
- **Parsed Show Name**: Should be "90's A Middle Class Biopic" but matched to "Class"
- **Show Name in DB**: "क्लास" (Hindi for "Class")
- **TVDB ID**: 425282 (for "Class" 2023)
- **TMDB ID**: 211116 (for "Class" 2023)
- **IMDB ID**: tt22297684 (for "Class" 2023)
- **Sonarr Title**: "Class (2023)"

### Root Cause Analysis
1. **Title Parsing Issue**: The `parseTvTitle()` function likely extracts "90's A Middle Class Biopic" but:
   - The similarity scoring in TVDB/TMDB search is matching it to "Class" instead
   - "Middle Class Biopic" might be scoring high similarity with "Class"
2. **Wrong Show Matched**: "90's A Middle Class Biopic" is likely a different show (possibly a documentary or different series)
3. **Language Issue**: The show name is stored in Hindi ("क्लास") instead of English

### Evidence
- TVDB ID 425282 = "क्लास" / "Class" (2023) ✅ IDs are consistent
- TMDB ID 211116 = "Class" (2023) ✅
- But the RSS title clearly says "90's A Middle Class Biopic" which is NOT "Class"

### Impact
**CRITICAL**: Completely wrong show matched. "90's A Middle Class Biopic" ≠ "Class (2023)".

---

## Root Causes Summary

### 1. Title Similarity Scoring Issues
- The `calculateTitleSimilarity()` function is matching shows with low similarity
- "Azad" should NOT match "Le Mille E Una Notte"
- "90's A Middle Class Biopic" should NOT match "Class"

### 2. Missing Validation
- No validation that the matched show name is actually similar to the parsed show name
- No threshold check (e.g., similarity must be > 0.7 to accept match)

### 3. Manual Override Issues
- "Rise and Fall" has manually set TMDB ID that doesn't match the IMDB ID
- No validation when manual IDs are set

### 4. TVDB Search Priority
- TVDB search is returning incorrect results, and we're taking the first/best match without sufficient validation
- Need to verify that the matched show name is actually similar to the search query

### 5. Year/Context Mismatch
- "Azad.2025" is being matched to a 2012 show
- "Rise and Fall.2025" might be matched to wrong show
- Year information is not being used effectively in matching

---

## Recommendations (No Changes - Analysis Only)

### 1. Add Similarity Threshold
- Require minimum similarity score (e.g., 0.6-0.7) before accepting a match
- Reject matches below threshold

### 2. Add Show Name Validation
- After matching, verify that the matched show name contains key words from the parsed show name
- For "Azad", the matched show should contain "Azad" or be very similar

### 3. Use Year Information
- If year is extracted from RSS title, prioritize matches with similar years
- Reject matches with year difference > 2-3 years

### 4. Validate ID Consistency
- When TVDB ID is found, verify that TMDB/IMDB IDs match
- If mismatch detected, log warning and don't use the IDs

### 5. Improve Title Parsing
- Better handling of titles like "90's A Middle Class Biopic"
- Don't remove "90's" or "A" from show names if they're part of the actual title

### 6. Add Manual Override Validation
- When user manually sets IDs, validate that they match each other
- Check TVDB → TMDB → IMDB consistency

### 7. Better Logging
- Log the similarity scores for all considered matches
- Log why a match was selected over others
- This will help debug future issues

---

## Files to Review

1. **`src/services/tvMatchingEngine.ts`**
   - `enrichTvShow()` function - TVDB/TMDB search and matching
   - `parseTvTitle()` function - title parsing logic
   - Similarity scoring and match selection

2. **`src/utils/titleSimilarity.ts`**
   - `calculateTitleSimilarity()` function - similarity algorithm
   - `scoreTmdbMatch()` function - TMDB match scoring

3. **`src/tmdb/client.ts`**
   - `searchTv()` function - TMDB TV search with scoring

4. **`src/routes/data.ts`**
   - Manual override endpoints - validation needed

---

## Next Steps

1. Review similarity scoring algorithm
2. Add similarity threshold validation
3. Add year-based filtering
4. Add ID consistency validation
5. Improve title parsing for edge cases
6. Add better logging for debugging

