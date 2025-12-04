# Radarr API Analysis: Replace TMDB ID Feature

## Overview
This document analyzes Radarr API capabilities for implementing the "Replace" feature, which allows updating the TMDB ID of movies that have existing files.

## Key Requirements
1. **Preserve Last Downloaded File Name** - We have this in our local DB (`movie_file` JSON field)
2. **Use Library Import Feature** - Import existing files to the new movie entry

## Radarr API Capabilities & Limitations

### ✅ What We CAN Do

#### 1. **Get Current Movie Data**
- **Endpoint**: `GET /movie/{id}`
- **Returns**: Full movie object including:
  - `path` - Current movie folder path
  - `movieFile` - File information (id, relativePath, size, quality, mediaInfo)
  - `hasFile` - Boolean indicating if file exists
  - `qualityProfileId` - Not directly exposed, but can be inferred
  - `rootFolderPath` - Can be extracted from `path`

#### 2. **Delete Movie (Preserve Files)**
- **Endpoint**: `DELETE /movie/{id}`
- **Parameters**:
  - `deleteFiles: false` - Keeps files on disk
  - `addImportExclusion: false` - Doesn't add to exclusion list
- **Result**: Movie removed from Radarr, files remain on disk

#### 3. **Add New Movie**
- **Endpoint**: `POST /movie`
- **Required Fields**:
  - `tmdbId` - New TMDB ID
  - `title`, `year` - From lookup
  - `qualityProfileId` - Can use default or preserve from old movie
  - `rootFolderPath` - Can preserve from old movie's path
  - `addOptions.searchForMovie: false` - Don't auto-search

#### 4. **Manual Import (Library Import)**
- **Endpoint**: `POST /command` with `name: "ManualImport"`
- **Purpose**: Import existing files to a movie
- **Required Data**:
  - `files` - Array of file objects with:
    - `path` - Full path to the file
    - `quality` - Quality information
    - `languages` - Language information
  - `movieId` - The new movie ID
  - `folder` - Movie folder path
  - `importMode` - "Auto" or "Manual"

**Note**: Manual import is typically used when:
- Files exist on disk but aren't linked to a movie
- You want to import files to an existing movie entry
- Files are in the correct folder structure

### ❌ What We CANNOT Do

#### 1. **Update TMDB ID Directly**
- **Limitation**: Radarr API does NOT support updating `tmdbId` of an existing movie
- **Workaround**: Delete and re-add (which is what we're implementing)

#### 2. **Directly Transfer File Association**
- **Limitation**: Cannot directly move file association from one movie to another
- **Workaround**: Use manual import after re-adding the movie

#### 3. **Preserve All Metadata**
- **Limitation**: Some metadata may be lost:
  - Download history (can be preserved via API if needed)
  - Custom tags (if any)
  - Monitor status (can be set when re-adding)
  - Quality profile (can be preserved)

## Data We Can Preserve

### From Local Database (`radarr_movies` table):
1. **File Information** (`movie_file` JSON):
   ```json
   {
     "id": 123,
     "relativePath": "Movie Name (2024)/Movie.Name.2024.1080p.BluRay.mkv",
     "size": 1234567890,
     "quality": { ... },
     "mediaInfo": { ... }
   }
   ```
2. **Movie Path** (`path`):
   - Full path to movie folder
   - Can extract root folder from this
3. **Original Language** (`original_language`)
4. **Date Added** (`date_added`)

### From Radarr API (Current Movie):
1. **Quality Profile ID** - Need to infer or use default
2. **Root Folder Path** - Extract from `path`
3. **Monitor Status** - Can preserve
4. **File Path** - Full path to the actual file

## Implementation Strategy

### Option 1: Manual Import After Re-add (Recommended)

**Steps**:
1. Get current movie data (including `movieFile`)
2. Extract file path: `{movie.path}/{movieFile.relativePath}`
3. Delete movie with `deleteFiles: false` (preserves files)
4. Lookup new movie by new TMDB ID
5. Add new movie with same `rootFolderPath` and `qualityProfileId`
6. Use Manual Import command to link existing file to new movie

**Pros**:
- Files remain in place
- Radarr handles file linking properly
- Preserves file metadata (quality, size, etc.)

**Cons**:
- Requires manual import step
- File must be in correct location

### Option 2: Move File + Manual Import

**Steps**:
1. Get current movie data
2. Delete movie with `deleteFiles: false`
3. Add new movie (creates new folder structure)
4. Move file from old location to new location
5. Use Manual Import to link file

**Pros**:
- Maintains proper folder structure
- Radarr manages file organization

**Cons**:
- Requires file system operations
- More complex
- Risk of file movement errors

### Option 3: Add Movie to Same Path + Manual Import

**Steps**:
1. Get current movie data
2. Extract root folder from `path`
3. Delete movie with `deleteFiles: false`
4. Add new movie with same `rootFolderPath`
5. Use Manual Import pointing to existing file location

**Pros**:
- Files stay in place
- Simpler than moving files
- Radarr can handle file in existing location

**Cons**:
- May create folder structure issues
- Need to ensure file path is correct

## Recommended Approach: Option 1

### Detailed Flow:

1. **Get Current Movie**:
   ```typescript
   const currentMovie = await radarrClient.getMovie(radarrId);
   const filePath = `${currentMovie.path}/${currentMovie.movieFile.relativePath}`;
   const rootFolder = extractRootFolder(currentMovie.path);
   ```

2. **Delete Movie (Preserve Files)**:
   ```typescript
   await radarrClient.deleteMovie(radarrId, false, false);
   ```

3. **Lookup New Movie**:
   ```typescript
   const newMovie = await radarrClient.lookupMovieByTmdbId(newTmdbId);
   ```

4. **Add New Movie**:
   ```typescript
   const addedMovie = await radarrClient.addMovie(
     newMovie,
     qualityProfileId, // Preserve from old movie
     rootFolder        // Preserve from old movie
   );
   ```

5. **Manual Import**:
   ```typescript
   await radarrClient.manualImport({
     movieId: addedMovie.id,
     files: [{
       path: filePath,
       quality: currentMovie.movieFile.quality,
       languages: [...]
     }],
     folder: addedMovie.path,
     importMode: "Auto"
   });
   ```

## Radarr API Endpoints Needed

### 1. Manual Import Command
- **Endpoint**: `POST /command`
- **Command Name**: `ManualImport`
- **Body Structure** (based on Radarr API v3):
  ```json
  {
    "name": "ManualImport",
    "files": [
      {
        "path": "/full/path/to/file.mkv",
        "quality": {
          "quality": {
            "id": 4,
            "name": "Bluray-1080p"
          },
          "revision": {
            "version": 1,
            "real": 0
          }
        },
        "languages": [
          {
            "id": 1,
            "name": "English"
          }
        ],
        "releaseGroup": "RARBG",
        "indexerFlags": 0
      }
    ],
    "movieId": 123,
    "folder": "/movies/Movie Name (2024)",
    "importMode": "Auto"
  }
  ```

**Note**: The exact structure may vary. We'll need to:
- Extract quality info from `movieFile.quality` in our DB
- Extract language info (may need to infer or use defaults)
- Construct full file path from `path` + `movieFile.relativePath`

### 2. Get Movie History (Optional - for preserving download info)
- **Endpoint**: `GET /history/movie?movieId={id}`
- **Purpose**: Get download history if needed

## Implementation Checklist

- [ ] Add `manualImport()` method to `RadarrClient`
- [ ] Add `getMovieHistory()` method if needed
- [ ] Extract file path from `movie_file` JSON in local DB
- [ ] Preserve quality profile (may need to infer from movie)
- [ ] Preserve root folder from current movie path
- [ ] Implement Replace endpoint with manual import
- [ ] Handle edge cases (file not found, import fails, etc.)
- [ ] Update local database after successful replace
- [ ] Add error handling and user feedback

## Risks & Considerations

1. **File Path Changes**: If Radarr creates a new folder structure, file may not be in expected location
2. **Quality Profile**: May not be directly accessible, need to use default or infer
3. **Import Failures**: Manual import may fail if file path is incorrect
4. **File Permissions**: Need to ensure file is accessible
5. **Concurrent Operations**: Ensure no other operations are modifying the movie

## Evaluation Summary

### ✅ What We CAN Do:
1. **Get current movie data** (path, file info, quality, etc.)
2. **Delete movie preserving files** (`deleteFiles: false`)
3. **Add new movie** with preserved settings (root folder, quality profile)
4. **Manual import existing files** to new movie entry
5. **Preserve file metadata** (quality, size, codec info) from local DB

### ❌ What We CANNOT Do:
1. **Update TMDB ID directly** - Not supported by Radarr API
2. **Directly transfer file association** - Must use manual import
3. **Preserve download history** - Lost when deleting movie (unless we store it separately)

### ⚠️ Challenges:
1. **Quality Profile ID** - Not directly exposed in movie object, may need to use default
2. **File Path Construction** - Need to ensure correct full path: `{movie.path}/{movieFile.relativePath}`
3. **Manual Import Format** - Exact structure needs verification from Radarr API docs
4. **Language Information** - May need to infer from file or use defaults

## Recommended Implementation Plan

### Phase 1: Research & Verification
1. ✅ Document current capabilities (this document)
2. ⏳ Test Manual Import API with sample request
3. ⏳ Verify file path construction from stored data
4. ⏳ Test quality profile preservation

### Phase 2: Core Implementation
1. Add `manualImport()` method to `RadarrClient`
2. Add helper to extract quality profile from movie (or use default)
3. Implement Replace endpoint with full flow:
   - Get current movie + file info
   - Delete movie (preserve files)
   - Add new movie (preserve settings)
   - Manual import existing file
4. Update local database

### Phase 3: Error Handling & Edge Cases
1. Handle file not found scenarios
2. Handle manual import failures
3. Handle path mismatches
4. Add rollback logic if any step fails

### Phase 4: Testing
1. Test with movies that have files
2. Test with different quality profiles
3. Test with different root folders
4. Verify file linking works correctly

## Next Steps

1. **Verify Manual Import API Format** - Test with Radarr API or check official docs
2. **Implement `manualImport()` method** - Add to `RadarrClient`
3. **Test file path extraction** - Ensure we can construct correct paths from stored data
4. **Implement Replace endpoint** - Full flow with error handling
5. **Add comprehensive logging** - Track each step for debugging
6. **Test with real movies** - Validate end-to-end functionality

