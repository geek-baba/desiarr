export interface VersionEntry {
  version: string;
  date: string;
  highlights: string[];
}

// Keep this list concise and focused on major user-visible changes only.
export const VERSION_HISTORY: VersionEntry[] = [
  {
    version: '2.1.0',
    date: '2025-12-02',
    highlights: [
      'Added Vitest-based testing infrastructure and initial unit/smoke tests',
      'Improved movie title and language handling on the dashboard (TMDB-only language, better filename cleanup for matched movies)',
      'Updated upgrade logic to treat releases with ≥25% larger file size as upgrade candidates',
      'Fixed RSS data tools and added regression-testing documentation'
    ],
  },
  {
    version: '2.0.0',
    date: '2025-11-01',
    highlights: [
      'Introduced the new dashboard layout with movie and TV sections',
      'Added TV matching engine and TV releases dashboard',
      'Refined quality scoring rules and settings UI',
      'Improved Radarr/Sonarr integration and sync reliability'
    ],
  },
];


