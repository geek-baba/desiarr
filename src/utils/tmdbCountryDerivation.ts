import { getCountryName } from './countryMapping';

export interface TMDBProductionCountry {
  iso_3166_1: string;
  name: string;
}

/**
 * Derive primary_country from stored TMDB data
 * Priority: production_countries[0].name > origin_country[0] (converted to name) > null
 * 
 * @param productionCountriesJson - JSON string of production_countries array
 * @param originCountryJson - JSON string of origin_country array (ISO codes)
 * @returns Primary country name or null
 */
export function derivePrimaryCountry(
  productionCountriesJson: string | null | undefined,
  originCountryJson: string | null | undefined
): string | null {
  // Try production_countries first
  if (productionCountriesJson) {
    try {
      const productionCountries: TMDBProductionCountry[] = JSON.parse(productionCountriesJson);
      if (Array.isArray(productionCountries) && productionCountries.length > 0 && productionCountries[0].name) {
        return productionCountries[0].name;
      }
    } catch (e) {
      // Invalid JSON, continue to fallback
    }
  }

  // Fallback to origin_country
  if (originCountryJson) {
    try {
      const originCountry: string[] = JSON.parse(originCountryJson);
      if (Array.isArray(originCountry) && originCountry.length > 0) {
        const countryName = getCountryName(originCountry[0]);
        if (countryName) {
          return countryName;
        }
      }
    } catch (e) {
      // Invalid JSON, return null
    }
  }

  return null;
}

/**
 * Derive primary_country from TMDBMovie object (for use during sync)
 * This is used when we have the full TMDBMovie object from API
 * 
 * @param tmdbMovie - TMDBMovie object from API
 * @returns Primary country name or null
 */
export function derivePrimaryCountryFromMovie(tmdbMovie: {
  production_countries?: TMDBProductionCountry[];
  origin_country?: string[];
}): string | null {
  // Try production_countries first
  if (tmdbMovie.production_countries && tmdbMovie.production_countries.length > 0) {
    return tmdbMovie.production_countries[0].name;
  }

  // Fallback to origin_country
  if (tmdbMovie.origin_country && tmdbMovie.origin_country.length > 0) {
    return getCountryName(tmdbMovie.origin_country[0]);
  }

  return null;
}

