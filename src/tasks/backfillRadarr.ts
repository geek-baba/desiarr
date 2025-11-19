import db from '../db';
import radarrClient from '../radarr/client';

interface BackfillRow {
  id: number;
  title: string;
  tmdb_id: number;
}

export interface BackfillRadarrSummary {
  totalCandidates: number;
  updated: number;
  skipped: number;
  notFound: number;
  errors: Array<{ id: number; title: string; error: string }>;
}

function formatExistingFileAttributes(movie: any) {
  if (!movie?.movieFile) {
    return null;
  }

  const file = movie.movieFile;
  const mediaInfo = file.mediaInfo || {};

  const attributes = {
    path: file.relativePath || null,
    resolution: mediaInfo.resolution || file.quality?.quality?.name || null,
    codec: mediaInfo.videoCodec || null,
    sourceTag: file.quality?.quality?.source || null,
    audio: mediaInfo.audioCodec || null,
    audioFromMediaInfo: mediaInfo.audioCodec,
    audioChannelsFromMediaInfo: mediaInfo.audioChannels,
    audioLanguages: mediaInfo.audioLanguages,
    videoCodec: mediaInfo.videoCodec,
    sizeMb: file.size ? file.size / (1024 * 1024) : null,
    lastDownload: null as any,
  };

  return JSON.stringify(attributes);
}

export async function backfillRadarrLinks(): Promise<BackfillRadarrSummary> {
  const rows = db
    .prepare(
      `SELECT id, title, tmdb_id
       FROM releases
       WHERE tmdb_id IS NOT NULL
         AND radarr_movie_id IS NULL`
    )
    .all() as BackfillRow[];

  const summary: BackfillRadarrSummary = {
    totalCandidates: rows.length,
    updated: 0,
    skipped: 0,
    notFound: 0,
    errors: [],
  };

  for (const row of rows) {
    if (!row.tmdb_id) {
      summary.skipped += 1;
      continue;
    }

    try {
      const movie = await radarrClient.getMovie(row.tmdb_id);
      if (movie && movie.id) {
        const existingSizeMb = movie.movieFile ? movie.movieFile.size / (1024 * 1024) : null;
        const existingFilePath = movie.movieFile?.relativePath || null;
        const existingFileAttributes = formatExistingFileAttributes(movie);

        db.prepare(
          `UPDATE releases
           SET radarr_movie_id = ?,
               radarr_movie_title = ?,
               existing_size_mb = ?,
               existing_file_path = ?,
               existing_file_attributes = ?,
               last_checked_at = datetime('now')
           WHERE id = ?`
        ).run(
          movie.id,
          movie.title,
          existingSizeMb,
          existingFilePath,
          existingFileAttributes,
          row.id
        );

        summary.updated += 1;
      } else {
        summary.notFound += 1;
      }
    } catch (error: any) {
      summary.errors.push({
        id: row.id,
        title: row.title,
        error: error?.message || 'Unknown error',
      });
    }
  }

  return summary;
}


