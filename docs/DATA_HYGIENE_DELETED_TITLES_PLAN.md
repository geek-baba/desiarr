# Data Hygiene - Deleted Titles Enhancement Plan

## Overview
Enhance the "Deleted Titles" tab in Data Hygiene to provide better management of movies that have been deleted from TMDB but still exist in Radarr.

## Current State
- Shows 24 movies marked as `is_deleted = 1` in `tmdb_movie_cache`
- Displays: Title, Year, TMDB ID, IMDB ID, Status, Last Attempt, Actions (Retry Sync)
- "Retry Sync" button attempts to re-sync from TMDB (which will fail since movie is deleted)

## Requirements

### 1. Remove "Retry Sync" Button ✅
**Rationale:** If a movie is deleted from TMDB, retrying the sync serves no purpose and will always fail.

**Implementation:**
- Remove the "Retry Sync" button from `views/data-hygiene.ejs`
- Remove the `retrySync()` JavaScript function
- Remove the `POST /data-hygiene/retry-sync/:tmdbId` endpoint from `src/routes/dataHygiene.ts`

**Files to modify:**
- `views/data-hygiene.ejs`
- `src/routes/dataHygiene.ts`

---

### 2. Add "Has File" Column ✅
**Rationale:** Distinguish between movies with downloaded files (need careful handling) vs. movies without files (safe to delete).

**Implementation:**
- Add "Has File" column header in the table
- Query `radarr_movies.has_file` field (already synced from Radarr API)
- Display: ✓ (green) if `has_file = 1`, ✗ (gray) if `has_file = 0`
- Update `getDeletedTitles()` in `src/services/dataHygieneService.ts` to include `has_file` field

**Data Source:**
- `radarr_movies.has_file` (already synced, stored as INTEGER: 0 or 1)
- This field comes from Radarr API's `hasFile` property

**Files to modify:**
- `src/services/dataHygieneService.ts` - Add `has_file` to query and return type
- `views/data-hygiene.ejs` - Add column header and display logic

---

### 3. Add "Delete" Button ✅
**Rationale:** Allow users to remove deleted movies from Radarr library.

**Radarr API Research:**
- **Endpoint:** `DELETE /api/v3/movie/{id}`
- **Parameters:** 
  - `deleteFiles` (boolean, optional): Delete movie files from disk
  - `addImportExclusion` (boolean, optional): Add to import exclusion list
- **Response:** 200 OK on success

**Implementation:**
- Add "Delete" button in Actions column
- Show confirmation dialog: "Delete this movie from Radarr? [Options: Delete files / Keep files]"
- Add `POST /data-hygiene/delete-movie/:radarrId` endpoint
- Implement `deleteMovie(radarrId, deleteFiles)` in `src/radarr/client.ts`
- Handle errors gracefully (movie already deleted, network errors, etc.)

**Safety Considerations:**
- Default to `deleteFiles: false` (keep files on disk)
- Show clear warning for movies with files
- Log all delete operations to structured logs

**Files to modify:**
- `src/radarr/client.ts` - Add `deleteMovie(radarrId, deleteFiles)` method
- `src/routes/dataHygiene.ts` - Add DELETE endpoint
- `views/data-hygiene.ejs` - Add delete button and confirmation modal

---

### 4. Wishful Thinking: Update TMDB ID (Simpler Alternative) ✅
**Rationale:** When a movie is deleted from TMDB, it's often replaced by a new entry (e.g., re-release, remaster, different region). Instead of complex delete/add migration, we can simply **update the TMDB ID** on the existing Radarr movie entry.

**Key Insight:** Radarr API supports `PUT /api/v3/movie/{id}` to update existing movie properties, including `tmdbId`. This is much simpler than delete/add!

**Radarr API Research:**
- **Update Movie:** `PUT /api/v3/movie/{id}` - Updates existing movie properties
- **TMDB ID Update:** Radarr API allows updating `tmdbId` on an existing movie
- **Benefits:**
  - ✅ Preserves all history (no transfer needed - history stays with same movie ID)
  - ✅ Preserves file references (no path changes - files stay in place)
  - ✅ Preserves all metadata (monitored status, quality profile, tags, etc.)
  - ✅ Much simpler than delete/add (single API call)
  - ✅ No file system changes required
  - ✅ Radarr automatically refreshes metadata from new TMDB entry

**Implementation:**
- Add "Update TMDB ID" button
- User searches/selects new TMDB ID (via TMDB search or manual entry)
- System:
  1. Fetches current movie from Radarr (by Radarr ID) - `GET /api/v3/movie/{id}`
  2. Validates new TMDB ID exists (via TMDB API)
  3. Updates movie via `PUT /api/v3/movie/{id}` with new `tmdbId`
  4. Radarr automatically:
     - Updates metadata from new TMDB entry (title, year, images, etc.)
     - Keeps all existing files, history, and settings
     - Refreshes movie information
  5. Updates local database (`radarr_movies`, `tmdb_movie_cache`)

**Files to modify:**
- `src/radarr/client.ts` - Add `updateMovie(radarrId, updates)` method
- `src/routes/dataHygiene.ts` - Add update endpoint
- `views/data-hygiene.ejs` - Add "Update TMDB ID" button and search modal

**Safety Considerations:**
- Validate new TMDB ID exists and is valid before updating
- Show confirmation dialog with old vs. new TMDB ID comparison
- Handle errors gracefully (invalid TMDB ID, network errors, Radarr validation errors)
- Log all updates to structured logs
- Consider: What if new TMDB ID is already used by another movie in Radarr? (Radarr should handle this)

**Limitations:**
- Radarr may refresh metadata (title, year, etc.) from new TMDB entry
- If new TMDB entry has different title/year, Radarr may want to rename folder (but won't without user action)
- Some edge cases (TMDB ID already in use by another movie, etc.) - Radarr API should handle these

**Future Enhancement (Auto-Detection):**
- Automatically search TMDB for replacement entries
- Match by: Title + Year, IMDB ID, or similar titles
- Present matches to user for confirmation
- Same update process

---

## Implementation Priority

1. **High Priority (Quick Wins):**
   - ✅ Remove "Retry Sync" button
   - ✅ Add "Has File" column

2. **Medium Priority (Useful Feature):**
   - ✅ Add "Delete" button with confirmation

3. **Low Priority (Useful Feature):**
   - ✅ Update TMDB ID (Simple - just update the tmdbId field via PUT API)
   - ⚠️ Auto-detect replacement TMDB entry (Future enhancement)

---

## Technical Details

### Database Schema
- `radarr_movies.has_file` - Already exists (INTEGER: 0 or 1)
- `tmdb_movie_cache.is_deleted` - Already exists (INTEGER: 0 or 1)

### Radarr API Endpoints to Use
- `GET /api/v3/movie/{id}` - Get movie details (already implemented)
- `PUT /api/v3/movie/{id}` - Update movie (NEW - need to implement)
- `DELETE /api/v3/movie/{id}?deleteFiles=false&addImportExclusion=false` - Delete movie (for delete button)
- `POST /api/v3/movie` - Add movie (already implemented)
- `GET /api/v3/movie/lookup/tmdb?tmdbId={id}` - Lookup by TMDB ID (already implemented)

### Error Handling
- Network errors: Show user-friendly message, log to structured logs
- Movie already deleted: Handle gracefully (404 response)
- File transfer failures: Rollback if possible, log error
- Validation errors: Show specific error message from Radarr API

---

## Testing Plan

1. **Remove Retry Sync:**
   - Verify button is removed
   - Verify no JavaScript errors

2. **Has File Column:**
   - Verify column displays correctly
   - Test with movies that have files vs. don't have files
   - Verify data matches Radarr UI

3. **Delete Button:**
   - Test delete with `deleteFiles: false` (keep files)
   - Test delete with `deleteFiles: true` (remove files)
   - Test error handling (movie already deleted, network error)
   - Verify movie is removed from Radarr UI after deletion

4. **Migration (if implemented):**
   - Test manual migration with movie that has file
   - Test manual migration with movie without file
   - Verify file is preserved and accessible in new entry
   - Test error handling (invalid TMDB ID, file path issues)

---

## Questions for Review

1. **Delete Files Option:**
   - Should we default to `deleteFiles: false` (keep files)?
   - Should we show a checkbox in the confirmation dialog?

2. **Update TMDB ID Feature:**
   - Should we implement this now? (It's much simpler than migration)
   - Should we add auto-detection of replacement TMDB entry, or keep it manual?

3. **UI/UX:**
   - Should "Delete" button be red/destructive styling?
   - Should we show a warning icon for movies with files?

4. **Logging:**
   - Should we log all delete/migration operations to structured logs?
   - Should we show operation history in the UI?

---

## Proposed File Changes Summary

### Files to Modify:
1. `src/services/dataHygieneService.ts` - Add `has_file` to `getDeletedTitles()`
2. `src/routes/dataHygiene.ts` - Remove retry endpoint, add delete endpoint, add update TMDB ID endpoint
3. `src/radarr/client.ts` - Add `deleteMovie()` method, add `updateMovie()` method
4. `views/data-hygiene.ejs` - Remove retry button, add has_file column, add delete button, add update TMDB ID button

### New Files (if Phase 1 implemented):
- None (all functionality in existing files)

---

## Risk Assessment

### Low Risk:
- Removing "Retry Sync" button
- Adding "Has File" column

### Medium Risk:
- Delete button (could accidentally delete movies, but has confirmation)

### Low Risk:
- Update TMDB ID (simple API call, Radarr handles all the complexity)

---

## Recommendation

**Implement Now:**
1. Remove "Retry Sync" button ✅
2. Add "Has File" column ✅
3. Add "Delete" button ✅

**Defer to Future:**
- Auto-detect replacement TMDB entry - Complex auto-detection logic (but update itself is simple)

This approach provides immediate value while keeping complexity manageable.

