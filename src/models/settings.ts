import db from '../db';
import { QualitySettings } from '../types/QualitySettings';

export const settingsModel = {
  get: (key: string): string | null => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  },

  set: (key: string, value: string): void => {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
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
    return JSON.parse(value);
  },

  setQualitySettings: (settings: QualitySettings): void => {
    settingsModel.set('qualitySettings', JSON.stringify(settings));
  },
};

