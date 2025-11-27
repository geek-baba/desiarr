import db from '../db';
import { AppSettings, QualitySettings } from '../types/QualitySettings';

export const settingsModel = {
  get: (key: string): string | null => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  },

  set: (key: string, value: string): void => {
    try {
      console.log(`SettingsModel.set: Setting key="${key}", value length=${value.length}`);
      const stmt = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
      const result = stmt.run(key, value);
      console.log(`SettingsModel.set: Result changes=${result.changes}, lastInsertRowid=${result.lastInsertRowid}`);
      
      // Verify it was saved
      const verify = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (verify && verify.value === value) {
        console.log(`SettingsModel.set: ✓ Verified key="${key}" was saved correctly`);
      } else {
        console.error(`SettingsModel.set: ✗ ERROR - Key="${key}" was NOT saved correctly!`);
        console.error(`  Expected: ${value.substring(0, 50)}...`);
        console.error(`  Got: ${verify?.value?.substring(0, 50) || 'null'}...`);
      }
    } catch (error: any) {
      console.error(`SettingsModel.set: ERROR saving key="${key}":`, error);
      throw error;
    }
  },

  getAll: (): Array<{ key: string; value: string }> => {
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>;
    return rows;
  },

  getQualitySettings: (): QualitySettings => {
    const value = settingsModel.get('qualitySettings');
    if (!value) {
      throw new Error('Quality settings not found');
    }
    const parsed = JSON.parse(value);
    // Legacy cleanup: remove app-level fields if they exist
    delete parsed.pollIntervalMinutes;
    delete parsed.radarrSyncIntervalHours;
    delete parsed.rssSyncIntervalHours;
    delete parsed.sonarrSyncIntervalHours;
    return parsed;
  },

  setQualitySettings: (settings: QualitySettings): void => {
    settingsModel.set('qualitySettings', JSON.stringify(settings));
  },

  getAppSettings: (): AppSettings => {
    const value = settingsModel.get('appSettings');
    if (value) {
      return JSON.parse(value);
    }

    // Migration path: fall back to legacy fields inside quality settings
    const quality = settingsModel.get('qualitySettings');
    const legacy = quality ? JSON.parse(quality) : {};
    const migrated: AppSettings = {
      pollIntervalMinutes: legacy.pollIntervalMinutes || 60,
      radarrSyncIntervalHours: legacy.radarrSyncIntervalHours || 6,
      sonarrSyncIntervalHours: legacy.sonarrSyncIntervalHours || 6,
      rssSyncIntervalHours: legacy.rssSyncIntervalHours || 1,
    };
    settingsModel.set('appSettings', JSON.stringify(migrated));
    return migrated;
  },

  setAppSettings: (settings: AppSettings): void => {
    settingsModel.set('appSettings', JSON.stringify(settings));
  },
};

