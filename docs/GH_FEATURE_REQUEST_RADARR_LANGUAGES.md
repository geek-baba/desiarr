# Feature Request: Add Gujarati and Punjabi Language Support

## Summary
Radarr currently supports 8 major Indian languages (Hindi, Bengali, Marathi, Telugu, Tamil, Urdu, Kannada, Malayalam) but is missing **Gujarati** and **Punjabi**, which are among the top 10 most spoken languages in India.

## Problem Statement
When managing Indian regional movies, Radarr cannot properly identify or set the language for:
- **Gujarati** (ISO 639-1: `gu`, ISO 639-2: `guj`)
- **Punjabi** (ISO 639-1: `pa`, ISO 639-2: `pan`)

This causes issues when:
1. MediaInfo correctly detects these languages in audio tracks
2. TMDB metadata indicates these as original languages
3. Users need to manually set file languages, but the options are not available in the UI

## Use Case
Many Indian regional movies are released in Gujarati and Punjabi. When these movies are added to Radarr:
- MediaInfo analysis correctly identifies the audio language (e.g., `pan` for Punjabi)
- TMDB metadata shows the correct original language
- However, Radarr's file language dropdown does not include these options
- Users are forced to either leave the language as "English" (incorrect) or set it to "Unknown" (not ideal)

## Current Behavior
- Radarr's `/api/v3/language` endpoint returns a list that includes "Original" and "Unknown" but not "Gujarati" or "Punjabi"
- The UI language dropdown for movie files does not show these languages
- When attempting to set file language via API, these languages are not recognized

## Expected Behavior
1. Add "Gujarati" to Radarr's language list (both API and UI)
2. Add "Punjabi" to Radarr's language list (both API and UI)
3. These should appear in:
   - `/api/v3/language` endpoint response
   - Movie file language dropdown in UI
   - Movie file language field in API (`/api/v3/moviefile`)

## Technical Details

### ISO Language Codes
- **Gujarati**: 
  - ISO 639-1: `gu`
  - ISO 639-2: `guj`
  - MediaInfo code: `guj`
  
- **Punjabi**:
  - ISO 639-1: `pa`
  - ISO 639-2: `pan`
  - MediaInfo code: `pan`

### Current Radarr Language Support
Radarr currently supports these Indian languages:
- Hindi (`hi`)
- Bengali (`bn`)
- Marathi (`mr`)
- Telugu (`te`)
- Tamil (`ta`)
- Urdu (`ur`)
- Kannada (`kn`)
- Malayalam (`ml`)

### Missing Languages
- Gujarati (`gu`) ❌
- Punjabi (`pa`) ❌

## Example Scenario
**Movie**: "15 Lakh Kadon Aauga" (2019)
- TMDB ID: 758726
- TMDB original_language: `pa` (Punjabi)
- MediaInfo audioLanguages: `["pan"]` (Punjabi)
- Radarr file language: Currently shows "English" (incorrect) or must be set to "Unknown"

**Expected**: Radarr should allow setting the file language to "Punjabi" to match the actual audio track.

## Additional Context
- These are the 9th and 10th most spoken languages in India (after the 8 already supported)
- Many regional Indian movies are released in these languages
- MediaInfo correctly identifies these languages in audio tracks
- TMDB has proper metadata for these languages

## References
- ISO 639-1: https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
- ISO 639-2: https://en.wikipedia.org/wiki/ISO_639-2
- MediaInfo Language Codes: https://mediaarea.net/en/MediaInfo/Support/Formats

## Related Issues
(If any similar requests exist, link them here)

---

**Labels**: `enhancement`, `language`, `indian-languages`, `feature-request`


