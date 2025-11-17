import Parser from 'rss-parser';
import { feedsModel } from '../models/feeds';
import { parseRSSItem } from './parseRelease';
import { releasesModel } from '../models/releases';
import { settingsModel } from '../models/settings';
import { isReleaseAllowed, computeQualityScore } from '../scoring/qualityScore';
import { parseReleaseFromTitle } from '../scoring/parseFromTitle';
import radarrClient from '../radarr/client';
import { Release } from '../types/Release';
import { QualitySettings } from '../types/QualitySettings';

const parser = new Parser();

export async function fetchAndProcessFeeds(): Promise<void> {
  const feeds = feedsModel.getEnabled();
  const settings = settingsModel.getQualitySettings();

  console.log(`Fetching ${feeds.length} enabled RSS feeds...`);

  for (const feed of feeds) {
    try {
      console.log(`Fetching feed: ${feed.name} (${feed.url})`);
      const feedData = await parser.parseURL(feed.url);

      if (!feedData.items || feedData.items.length === 0) {
        console.log(`No items found in feed: ${feed.name}`);
        continue;
      }

      console.log(`Found ${feedData.items.length} items in feed: ${feed.name}`);

      for (const item of feedData.items) {
        try {
          const parsed = parseRSSItem(item, feed.id!, feed.name);

          // Check if release is allowed
          const allowed = isReleaseAllowed(parsed.parsed, settings);
          
          let status: Release['status'] = allowed ? 'NEW' : 'IGNORED';

          // If not allowed, just save as IGNORED
          if (!allowed) {
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            continue;
          }

          // For allowed releases, lookup in Radarr
          const lookupResults = await radarrClient.lookupMovie(parsed.title);
          
          if (lookupResults.length === 0) {
            // No movie found in Radarr - mark as NEW
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status: 'NEW',
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            continue;
          }

          // Use first lookup result
          const lookupResult = lookupResults[0];
          const radarrMovie = await radarrClient.getMovie(lookupResult.tmdbId);

          if (!radarrMovie || !radarrMovie.id) {
            // Movie not in Radarr - mark as NEW
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status: 'NEW',
              tmdb_id: lookupResult.tmdbId,
              tmdb_title: lookupResult.title,
              tmdb_original_language: lookupResult.originalLanguage?.name,
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            continue;
          }

          // Movie exists in Radarr - check if upgrade candidate
          const existingFile = radarrMovie.movieFile;
          const existingSizeMb = existingFile ? existingFile.size / (1024 * 1024) : undefined;

          // Determine if dubbed
          const originalLang = lookupResult.originalLanguage?.name || radarrMovie.originalLanguage?.name;
          const audioLangs = parsed.audio_languages ? JSON.parse(parsed.audio_languages) : [];
          const isDubbed = originalLang && audioLangs.length > 0 && !audioLangs.includes(originalLang.toLowerCase().substring(0, 2));

          // Check preferred language
          const preferredLanguage = audioLangs.some((lang: string) => 
            settings.preferredAudioLanguages.includes(lang)
          );

          // Compute quality scores
          const newScore = computeQualityScore(parsed.parsed, settings, {
            isDubbed,
            preferredLanguage,
          });

          // Compute existing score from existing file
          let existingScore = 0;
          if (existingFile) {
            // Try to parse existing file name to get quality info
            const existingFileName = existingFile.relativePath || '';
            const existingParsed = parseReleaseFromTitle(existingFileName);
            
            // Compute score for existing file using same logic as new releases
            const existingPreferredLanguage = radarrMovie.originalLanguage && 
              settings.preferredAudioLanguages.includes(radarrMovie.originalLanguage.name.toLowerCase().substring(0, 2));
            
            existingScore = computeQualityScore(existingParsed, settings, {
              isDubbed: false, // Assume existing file is not dubbed for scoring
              preferredLanguage: existingPreferredLanguage,
            });
            
            // If parsing failed, fall back to size-based estimate
            if (existingScore === 0 && existingSizeMb) {
              existingScore = Math.min(existingSizeMb / 100, 50);
            }
          }

          const scoreDelta = newScore - existingScore;
          const sizeDeltaPercent = existingSizeMb && parsed.rss_size_mb
            ? ((parsed.rss_size_mb - existingSizeMb) / existingSizeMb) * 100
            : 0;

          // Determine if upgrade candidate
          if (
            scoreDelta >= settings.upgradeThreshold &&
            sizeDeltaPercent >= settings.minSizeIncreasePercentForUpgrade
          ) {
            status = 'UPGRADE_CANDIDATE';
          } else {
            status = 'IGNORED';
          }

          const release: Omit<Release, 'id'> = {
            ...parsed,
            status,
            tmdb_id: lookupResult.tmdbId,
            tmdb_title: lookupResult.title,
            tmdb_original_language: originalLang,
            is_dubbed: isDubbed,
            radarr_movie_id: radarrMovie.id,
            radarr_movie_title: radarrMovie.title,
            existing_size_mb: existingSizeMb,
            radarr_existing_quality_score: existingScore,
            new_quality_score: newScore,
            last_checked_at: new Date().toISOString(),
          };

          releasesModel.upsert(release);
        } catch (itemError) {
          console.error(`Error processing item: ${item.title}`, itemError);
        }
      }
    } catch (feedError) {
      console.error(`Error fetching feed: ${feed.name}`, feedError);
    }
  }

  console.log('Finished processing all feeds');
}

