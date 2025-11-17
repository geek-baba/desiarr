import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8085', 10),
  radarr: {
    apiUrl: process.env.RADARR_API_URL || '',
    apiKey: process.env.RADARR_API_KEY || '',
  },
  db: {
    path: process.env.DB_PATH || './data/app.db',
  },
};

if (!config.radarr.apiUrl || !config.radarr.apiKey) {
  console.warn('Warning: RADARR_API_URL and RADARR_API_KEY must be set');
}

