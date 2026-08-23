import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  looksLikeRestaurantUrl,
  mergeSearchCandidates,
  normalizeRestaurantName,
  rankPickyCandidates,
} from '@/lib/restaurant-search-utils';
import {
  DUBLIN_SEARCH_RADIUS_METRES,
  GooglePlacesError,
  resolveGoogleRestaurant,
  searchGoogleRestaurants,
} from '@/lib/google-places';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('restaurant name search helpers', () => {
  it('normalizes punctuation, accents and ampersands for exact matching', () => {
    expect(normalizeRestaurantName('  DÁDA & Co.  ')).toBe('dada and co');
  });

  it('distinguishes restaurant names from usable URL inputs', () => {
    expect(looksLikeRestaurantUrl('https://unomas.ie/menu')).toBe(true);
    expect(looksLikeRestaurantUrl('www.unomas.ie')).toBe(true);
    expect(looksLikeRestaurantUrl('unomas.ie/menu')).toBe(true);
    expect(looksLikeRestaurantUrl('Uno Mas')).toBe(false);
  });

  it('ranks exact database matches before prefixes and substrings', () => {
    const ranked = rankPickyCandidates('uno mas', [
      { source: 'picky', restaurantId: '3', name: 'The Uno Mas Room', location: null, status: 'done' },
      { source: 'picky', restaurantId: '2', name: 'Uno Mas Temple Bar', location: null, status: 'done' },
      { source: 'picky', restaurantId: '1', name: 'Uno Mas', location: null, status: 'done' },
    ]);
    expect(ranked.map((candidate) => candidate.restaurantId)).toEqual(['1', '2', '3']);
    expect(ranked[0].exact).toBe(true);
  });

  it('keeps Picky first and removes an identical external suggestion', () => {
    const result = mergeSearchCandidates(
      [{ source: 'picky', restaurantId: '1', name: 'Uno Mas', location: 'Aungier Street, Dublin', status: 'done', exact: true }],
      [
        { source: 'google', placeId: 'same', name: 'Uno Mas', location: 'Aungier Street, Dublin', types: ['restaurant'] },
        { source: 'google', placeId: 'other', name: 'Uno Pizza', location: 'Rathmines, Dublin', types: ['pizza_restaurant'] },
      ]
    );
    expect(result.map((candidate) => candidate.source === 'picky' ? candidate.restaurantId : candidate.placeId))
      .toEqual(['1', 'other']);
  });
});

describe('Google Places adapter', () => {
  it('uses a Dublin restriction, minimal fields and filters non-food predictions', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'server-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      suggestions: [
        {
          placePrediction: {
            place: 'places/food-1',
            types: ['italian_restaurant'],
            structuredFormat: {
              mainText: { text: 'Grano' },
              secondaryText: { text: 'Stoneybatter, Dublin' },
            },
          },
        },
        {
          placePrediction: {
            place: 'places/shop-1',
            types: ['clothing_store'],
            text: { text: 'Grano Clothing' },
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const candidates = await searchGoogleRestaurants('Grano', 'session-1');
    expect(candidates).toEqual([{
      source: 'google',
      placeId: 'food-1',
      name: 'Grano',
      location: 'Stoneybatter, Dublin',
      types: ['italian_restaurant'],
    }]);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.includedRegionCodes).toEqual(['ie']);
    expect(body.locationRestriction.circle.radius).toBe(DUBLIN_SEARCH_RADIUS_METRES);
    expect(options.headers['X-Goog-Api-Key']).toBe('server-key');
    expect(options.headers['X-Goog-FieldMask']).not.toContain('rating');
  });

  it('requests the authoritative website only after selection', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'server-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      websiteUri: 'https://grano.ie',
      googleMapsUri: 'https://maps.google.com/example',
      businessStatus: 'OPERATIONAL',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveGoogleRestaurant('place/with spaces', 'session-1')).resolves.toEqual({
      websiteUrl: 'https://grano.ie',
      googleMapsUrl: 'https://maps.google.com/example',
      businessStatus: 'OPERATIONAL',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('place%2Fwith%20spaces');
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-FieldMask'])
      .toBe('websiteUri,googleMapsUri,businessStatus');
  });

  it('keeps provider diagnostics separate from actionable user copy', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'server-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));

    try {
      await resolveGoogleRestaurant('place-1', 'session-1');
      throw new Error('Expected Place Details to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GooglePlacesError);
      expect(error).toMatchObject({
        code: 'request_failed',
        operation: 'details',
        status: 403,
        message: 'Google Place Details returned 403',
        userMessage: 'Restaurant lookup is temporarily unavailable. Paste its website link or try again.',
      });
    }
  });
});

describe('restaurant search integration contracts', () => {
  it('keeps database lookup before the optional Google call and disables response caching', () => {
    const route = readFileSync('app/api/restaurant-search/route.ts', 'utf8');
    expect(route.indexOf('searchDublinRestaurantsByName(query)'))
      .toBeLessThan(route.indexOf('searchGoogleRestaurants(query'));
    expect(route).toContain("'Cache-Control': 'no-store, max-age=0'");
    expect(route).toContain('captureGooglePlacesFailure({');
  });

  it('keeps URL discovery backward compatible while accepting database and Google selections', () => {
    const discover = readFileSync('app/api/parse/discover/route.ts', 'utf8');
    expect(discover).toContain("z.object({ url: z.string().url('Please provide a valid URL') })");
    expect(discover).toContain("restaurantId: z.string().uuid('Invalid restaurant')");
    expect(discover).toContain('googlePlaceId: z.string().trim().min(1).max(256)');
    expect(discover.indexOf("findRestaurantIdByProviderPlace('google'"))
      .toBeLessThan(discover.indexOf('resolveGoogleRestaurant('));
  });

  it('masks raw restaurant input and provider suggestions from session replay', () => {
    const hero = readFileSync('components/HeroSearch.tsx', 'utf8');
    expect(hero).not.toContain('ph-no-mask');
    expect(hero).toContain('ph-no-capture relative');
    expect(hero).toContain('role="combobox"');
    expect(hero).toContain('aria-activedescendant');
  });
});
