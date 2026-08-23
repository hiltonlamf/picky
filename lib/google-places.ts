import type { GoogleRestaurantSearchCandidate } from '@/types';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const DUBLIN_CENTRE = { latitude: 53.3498, longitude: -6.2603 };
export const DUBLIN_SEARCH_RADIUS_METRES = 30_000;

export type GooglePlacesOperation = 'autocomplete' | 'details';

interface GooglePlacesErrorOptions {
  operation: GooglePlacesOperation;
  status?: number | null;
  userMessage?: string;
}

export class GooglePlacesError extends Error {
  public readonly operation: GooglePlacesOperation;
  public readonly status: number | null;
  public readonly userMessage: string;

  constructor(
    public readonly code: 'unavailable' | 'request_failed' | 'not_found',
    message: string,
    options: GooglePlacesErrorOptions
  ) {
    super(message);
    this.name = 'GooglePlacesError';
    this.operation = options.operation;
    this.status = options.status ?? null;
    this.userMessage = options.userMessage ?? message;
  }
}

function apiKey(operation: GooglePlacesOperation): string {
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    throw new GooglePlacesError('unavailable', 'GOOGLE_PLACES_API_KEY is not configured', {
      operation,
      userMessage: 'Restaurant name search is temporarily unavailable. Paste a website link instead.',
    });
  }
  return key;
}

function isFoodPlace(types: string[]): boolean {
  return types.some((type) =>
    type === 'restaurant' ||
    type.endsWith('_restaurant') ||
    ['cafe', 'coffee_shop', 'bar', 'pub', 'bakery', 'meal_takeaway', 'food_court'].includes(type)
  );
}

type GooglePrediction = {
  place?: string;
  placeId?: string;
  types?: string[];
  text?: { text?: string };
  structuredFormat?: {
    mainText?: { text?: string };
    secondaryText?: { text?: string };
  };
};

export async function searchGoogleRestaurants(
  query: string,
  sessionToken: string,
  signal?: AbortSignal
): Promise<GoogleRestaurantSearchCandidate[]> {
  const response = await fetch(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey('autocomplete'),
      'X-Goog-FieldMask': [
        'suggestions.placePrediction.place',
        'suggestions.placePrediction.placeId',
        'suggestions.placePrediction.types',
        'suggestions.placePrediction.text',
        'suggestions.placePrediction.structuredFormat',
      ].join(','),
    },
    body: JSON.stringify({
      input: query,
      includedRegionCodes: ['ie'],
      languageCode: 'en',
      regionCode: 'ie',
      sessionToken,
      locationRestriction: {
        circle: { center: DUBLIN_CENTRE, radius: DUBLIN_SEARCH_RADIUS_METRES },
      },
    }),
    signal,
  });
  if (!response.ok) {
    throw new GooglePlacesError('request_failed', `Google Places autocomplete returned ${response.status}`, {
      operation: 'autocomplete',
      status: response.status,
      userMessage: 'Restaurant name search is temporarily unavailable. Paste a website link or try again.',
    });
  }
  const payload = await response.json() as { suggestions?: Array<{ placePrediction?: GooglePrediction }> };
  return (payload.suggestions ?? [])
    .map((item) => item.placePrediction)
    .filter((prediction): prediction is GooglePrediction => !!prediction)
    .filter((prediction) => isFoodPlace(prediction.types ?? []))
    .map((prediction) => ({
      source: 'google' as const,
      placeId: prediction.placeId ?? prediction.place?.replace(/^places\//, '') ?? '',
      name: prediction.structuredFormat?.mainText?.text ?? prediction.text?.text ?? 'Restaurant',
      location: prediction.structuredFormat?.secondaryText?.text ?? null,
      types: prediction.types ?? [],
    }))
    .filter((candidate) => !!candidate.placeId)
    .slice(0, 6);
}

export interface ResolvedGooglePlace {
  websiteUrl: string | null;
  googleMapsUrl: string | null;
  businessStatus: string | null;
}

export async function resolveGoogleRestaurant(
  placeId: string,
  sessionToken: string,
  signal?: AbortSignal
): Promise<ResolvedGooglePlace> {
  const params = new URLSearchParams({ sessionToken });
  const response = await fetch(`${DETAILS_URL}/${encodeURIComponent(placeId)}?${params}`, {
    headers: {
      'X-Goog-Api-Key': apiKey('details'),
      'X-Goog-FieldMask': 'websiteUri,googleMapsUri,businessStatus',
    },
    signal,
  });
  if (response.status === 404) {
    throw new GooglePlacesError('not_found', 'Google Place Details returned 404', {
      operation: 'details',
      status: 404,
      userMessage: 'That restaurant is no longer available. Try another result.',
    });
  }
  if (!response.ok) {
    throw new GooglePlacesError('request_failed', `Google Place Details returned ${response.status}`, {
      operation: 'details',
      status: response.status,
      userMessage: 'Restaurant lookup is temporarily unavailable. Paste its website link or try again.',
    });
  }
  const payload = await response.json() as {
    websiteUri?: string;
    googleMapsUri?: string;
    businessStatus?: string;
  };
  return {
    websiteUrl: payload.websiteUri ?? null,
    googleMapsUrl: payload.googleMapsUri ?? null,
    businessStatus: payload.businessStatus ?? null,
  };
}
