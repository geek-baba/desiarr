# Replace TMDB ID Feature - Implementation Plan

## Overview
Implement the "Replace" feature to update TMDB ID for movies that have existing files, preserving file associations and download history.

## Key Requirements

1. **Preserve Last Downloaded File Name** - ✅ We have this in `radarr_movies.movie_file` (JSON)
2. **Preserve Download History** - ⚠️ Need to store before deletion
3. **Use Manual Import** - Link existing files to new movie entry
4. **Match by TMDB ID** - Radarr's Library Import matches files to movies by TMDB ID

## Understanding Radarr Library Import

Based on the screenshots:
- **Library Import** scans a folder and matches existing files to movies
- Files are matched to movies by TMDB ID (when files are in correct folder structure)
- Shows "Existing" tag when files are already linked
- Can import files that are in the library but not linked to a Radarr entry

## Flow Analysis

### Current Understanding:
1. Delete old movie → Files remain on disk (in old folder structure)
2. Add new movie → Creates new folder structure with new TMDB ID
3. Manual Import → Links existing file to new movie

### Challenge:
- Old file is in: `/movies/bollywood/Old Movie Name (2024)/file.mkv`
- New movie creates: `/movies/bollywood/New Movie Name (2024)/`
- File needs to be moved or imported from old location

## Radarr Manual Import API

Based on research, Manual Import command format:
```json
{
  "name": "ManualImport",
  "files": [
    {
      "path": "/full/path/to/file.mkv",
      "quality": { ... },
      "languages": [ ... ]
    }
  ],
  "movieId": 123,
  "folder": "/movies/Movie Name (2024)",
  "importMode": "Auto"  // or "Copy", "Move"
}
```

**Key Points:**
- `importMode: "Auto"` - Radarr decides (usually moves)
- `importMode: "Move"` - Moves file to movie folder
- `importMode: "Copy"` - Copies file (keeps original)
- File path can be anywhere - Radarr will move/copy to correct location
- Quality and language info needed for proper import

## Data Preservation Strategy

### 1. Download History Storage

**Option A: New Table (Recommended)**
```sql
CREATE TABLE IF NOT EXISTS radarr_movie_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  radarr_id INTEGER NOT NULL,
  tmdb_id INTEGER,
  history_data TEXT NOT NULL,  -- JSON array of RadarrHistory
  preserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  restored_to_radarr_id INTEGER,  -- If we restore it later
  restored_at TEXT
);

CREATE INDEX idx_history_radarr_id ON radarr_movie_history(radarr_id);
CREATE INDEX idx_history_tmdb_id ON radarr_movie_history(tmdb_id);
```

**Option B: Add to Existing Table**
- Add `history` JSON field to `radarr_movies` table
- Store before deletion, restore after re-add

**Recommendation: Option A** - Separate table allows:
- Multiple history snapshots
- Better tracking of what was preserved
- Easier to query and restore

### 2. File Information
- Already stored in `radarr_movies.movie_file` (JSON)
- Contains: `relativePath`, `size`, `quality`, `mediaInfo`
- Can construct full path: `{movie.path}/{movieFile.relativePath}`

## Implementation Plan

### Phase 1: History Preservation

1. **Add History Table**
   - Create `radarr_movie_history` table
   - Store full history JSON before deletion

2. **Add `preserveMovieHistory()` method**
   ```typescript
   async preserveMovieHistory(radarrId: number): Promise<void> {
     const history = await radarrClient.getMovieHistory(radarrId);
     const movie = await radarrClient.getMovie(radarrId);
     
     db.prepare(`
       INSERT INTO radarr_movie_history (radarr_id, tmdb_id, history_data)
       VALUES (?, ?, ?)
     `).run(radarrId, movie.tmdbId, JSON.stringify(history));
   }
   ```

### Phase 2: Manual Import API

1. **Add `manualImport()` method to RadarrClient**
   ```typescript
   async manualImport(params: {
     movieId: number;
     files: Array<{
       path: string;
       quality: any;
       languages: any[];
     }>;
     folder: string;
     importMode?: 'Auto' | 'Move' | 'Copy';
   }): Promise<void>
   ```

2. **Test Manual Import Format**
   - Need to verify exact API structure
   - Test with a sample movie
   - Verify file linking works

### Phase 3: Replace Endpoint Implementation

**Flow:**
1. Get current movie + file info + history
2. Preserve history in our DB
3. Extract file path: `{movie.path}/{movieFile.relativePath}`
4. Extract quality info from `movieFile.quality`
5. Extract language info (from `movieFile.mediaInfo.audioLanguages` or default)
6. Delete movie with `deleteFiles: false`
7. Lookup new movie by new TMDB ID
8. Add new movie (preserve root folder, use default quality profile)
9. Manual Import existing file to new movie
10. Update local database

### Phase 4: Error Handling

1. **Rollback Strategy**
   - If any step fails, attempt to restore
   - Log all steps for debugging
   - Provide clear error messages

2. **Edge Cases**
   - File not found at expected path
   - Manual import fails
   - New movie already exists
   - Quality/language info missing

## Questions Resolved ✅

1. **Manual Import API Format**
   - ✅ Will test with a sample movie to determine exact structure
   - Need to verify `files` array format and required fields

2. **File Location**
   - ✅ Manual Import does NOT move files - it just maps/links existing files
   - ✅ Files stay in their current location after import
   - ✅ If rename/move needed, trigger manual rename separately (we'll keep this behavior)
   - **Strategy**: Keep file in old location, Manual Import will link it to new movie

3. **Quality Profile**
   - ✅ Let Radarr detect quality from the file automatically
   - No need to preserve quality profile ID

4. **Language Information**
   - ✅ Use existing language from `radarr_movies.original_language`
   - We have this stored in our local DB
   - Format: Need to convert to Radarr's language object format (likely `{ id: number, name: string }`)

5. **History Restoration**
   - ✅ Cannot restore via API (Radarr limitation)
   - ✅ Just preserve in local DB for future reference
   - Store in `radarr_movie_history` table

## Implementation Steps

### Step 1: Database Schema - History Preservation
- Add `radarr_movie_history` table
- Store history JSON before deletion

### Step 2: History Preservation Helper
- Add `preserveMovieHistory()` function
- Fetch history from Radarr before deletion
- Store in local DB

### Step 3: Manual Import Method
- Add `manualImport()` to RadarrClient
- Test format with a sample movie
- Handle file mapping (not moving)

### Step 4: Replace Endpoint
- Get current movie + file info
- Preserve history
- Delete movie (keep files)
- Add new movie (same root folder)
- Manual Import existing file
- Update local database

### Step 5: Language Format Conversion
- Convert `original_language` string to Radarr language object
- May need to lookup language ID from Radarr API or use defaults

## Detailed Implementation Plan

### Phase 1: History Preservation (Foundation)
1. Add `radarr_movie_history` table
2. Create `preserveMovieHistory()` helper function
3. Test history fetching and storage

### Phase 2: Manual Import (Core Feature)
1. Research/test Manual Import API format
2. Add `manualImport()` method to RadarrClient
3. Test with a sample movie to verify format

### Phase 3: Replace Endpoint (Integration)
1. Implement full Replace flow
2. Add error handling and rollback
3. Update local database after success

### Phase 4: Testing & Refinement
1. Test with real movies
2. Verify file linking works
3. Test error scenarios
4. Refine based on results

## Alternative Approach (If Manual Import Doesn't Work)

If Manual Import API doesn't work as expected:

1. **Delete movie** (keep files)
2. **Move file** to a temporary location or keep in place
3. **Add new movie** (creates new folder)
4. **Use file system operations** to move file to new location
5. **Trigger Radarr scan** to detect the file

This is more complex but might be more reliable.

