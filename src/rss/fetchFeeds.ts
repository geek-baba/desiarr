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

      let processedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      let newCount = 0;
      let ignoredCount = 0;
      let upgradeCount = 0;

      for (const item of feedData.items) {
        try {
          if (!item.title && !item.link) {
            skippedCount++;
            continue; // Skip items without title or link
          }
          
          const parsed = parseRSSItem(item as any, feed.id!, feed.name);
          
          // Check if we've already processed this item (by guid)
          const existing = releasesModel.getByGuid(parsed.guid);
          if (existing && (existing.status === 'ADDED' || existing.status === 'UPGRADED')) {
            // Skip items that have already been added or upgraded
            continue;
          }

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
            ignoredCount++;
            continue;
          }

          // For allowed releases, lookup in Radarr
          // Use a more specific search term with year if available
          const searchTerm = parsed.year 
            ? `${parsed.title} ${parsed.year}` 
            : parsed.title;
          
          const lookupResults = await radarrClient.lookupMovie(searchTerm);
          
          if (lookupResults.length === 0) {
            // No movie found in Radarr - mark as NEW
            const release: Omit<Release, 'id'> = {
              ...parsed,
              status: 'NEW',
              last_checked_at: new Date().toISOString(),
            };
            releasesModel.upsert(release);
            newCount++;
            processedCount++;
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
            newCount++;
            processedCount++;
            continue;
          }

          // Movie exists in Radarr - check if upgrade candidate
          const existingFile = radarrMovie.movieFile;
          const existingSizeMb = existingFile ? existingFile.size / (1024 * 1024) : undefined;

          // Determine if dubbed
          const originalLang = lookupResult.originalLanguage?.name || radarrMovie.originalLanguage?.name;
          const audioLangs = parsed.audio_languages ? JSON.parse(parsed.audio_languages) : [];
          const isDubbed: boolean = Boolean(originalLang && audioLangs.length > 0 && !audioLangs.includes(originalLang.toLowerCase().substring(0, 2)));

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

          // Log detailed scoring for debugging
          if (radarrMovie.id) {
            console.log(`  ${parsed.title}: existingScore=${existingScore.toFixed(2)}, newScore=${newScore.toFixed(2)}, delta=${scoreDelta.toFixed(2)}, sizeDelta=${sizeDeltaPercent.toFixed(2)}%`);
            console.log(`    Existing file: ${existingFile?.relativePath || 'none'}, size=${existingSizeMb?.toFixed(2) || 'N/A'}MB`);
            console.log(`    New release: ${parsed.parsed.resolution} ${parsed.parsed.sourceTag} ${parsed.parsed.codec} ${parsed.parsed.audio}, size=${parsed.rss_size_mb?.toFixed(2) || 'N/A'}MB`);
          }

          // Determine if upgrade candidate
          if (
            scoreDelta >= settings.upgradeThreshold &&
            sizeDeltaPercent >= settings.minSizeIncreasePercentForUpgrade
          ) {
            status = 'UPGRADE_CANDIDATE';
            upgradeCount++;
          } else {
            status = 'IGNORED';
            ignoredCount++;
            if (radarrMovie.id) {
              const reasons: string[] = [];
              if (scoreDelta < settings.upgradeThreshold) {
                reasons.push(`scoreDelta ${scoreDelta.toFixed(2)} < threshold ${settings.upgradeThreshold}`);
              }
              if (sizeDeltaPercent < settings.minSizeIncreasePercentForUpgrade) {
                reasons.push(`sizeDelta ${sizeDeltaPercent.toFixed(2)}% < threshold ${settings.minSizeIncreasePercentForUpgrade}%`);
              }
              console.log(`    → IGNORED: ${reasons.join(', ')}`);
            }
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
          processedCount++;
        } catch (itemError) {
          errorCount++;
          console.error(`Error processing item: ${item.title || item.link || 'unknown'}`, itemError);
          // Continue processing other items even if one fails
        }
      }
      
      console.log(`Feed ${feed.name}: Processed ${processedCount}, Skipped ${skippedCount}, Errors ${errorCount}`);
      console.log(`  Status breakdown: NEW=${newCount}, UPGRADE_CANDIDATE=${upgradeCount}, IGNORED=${ignoredCount}`);
    } catch (feedError) {
      console.error(`Error fetching feed: ${feed.name}`, feedError);
    }
  }

  console.log('Finished processing all feeds');
}

