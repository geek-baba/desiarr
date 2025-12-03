/**
 * ISO 3166-1 alpha-2 country code to country name mapping
 * Focused on countries relevant to Indian cinema
 */
export const COUNTRY_NAMES: { [code: string]: string } = {
  // India and neighboring countries
  'IN': 'India',
  'PK': 'Pakistan',
  'BD': 'Bangladesh',
  'LK': 'Sri Lanka',
  'NP': 'Nepal',
  'BT': 'Bhutan',
  'MV': 'Maldives',
  'AF': 'Afghanistan',
  
  // Other major countries
  'US': 'United States',
  'GB': 'United Kingdom',
  'CA': 'Canada',
  'AU': 'Australia',
  'NZ': 'New Zealand',
  'ZA': 'South Africa',
  'AE': 'United Arab Emirates',
  'SG': 'Singapore',
  'MY': 'Malaysia',
  'TH': 'Thailand',
  'ID': 'Indonesia',
  'PH': 'Philippines',
  'CN': 'China',
  'JP': 'Japan',
  'KR': 'South Korea',
  'FR': 'France',
  'DE': 'Germany',
  'IT': 'Italy',
  'ES': 'Spain',
  'RU': 'Russia',
  'BR': 'Brazil',
  'MX': 'Mexico',
  'AR': 'Argentina',
};

/**
 * Convert ISO 3166-1 alpha-2 country code(s) to country name(s)
 * @param codes - Single code string, array of codes, or null/undefined
 * @returns Country name(s) or null if not found
 */
export function getCountryName(codes: string | string[] | null | undefined): string | null {
  if (!codes) return null;
  
  const codeArray = Array.isArray(codes) ? codes : [codes];
  if (codeArray.length === 0) return null;
  
  // Return the first valid country name found
  for (const code of codeArray) {
    if (code && COUNTRY_NAMES[code.toUpperCase()]) {
      return COUNTRY_NAMES[code.toUpperCase()];
    }
  }
  
  return null;
}

/**
 * Get all country names from an array of ISO codes
 * @param codes - Array of ISO country codes
 * @returns Array of country names
 */
export function getCountryNames(codes: string[] | null | undefined): string[] {
  if (!codes || codes.length === 0) return [];
  
  return codes
    .map(code => code && COUNTRY_NAMES[code.toUpperCase()])
    .filter((name): name is string => !!name);
}

