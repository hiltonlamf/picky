import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { searchDublinRestaurantsByName } from '@/lib/db';
import { GooglePlacesError, searchGoogleRestaurants } from '@/lib/google-places';
import { checkPlaceLookupRateLimit, getClientIp } from '@/lib/rate-limit';
import { mergeSearchCandidates } from '@/lib/restaurant-search-utils';
import type { RestaurantSearchResponse } from '@/types';

export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  query: z.string().trim().min(2).max(100),
  external: z.enum(['0', '1']).default('0'),
  sessionToken: z.string().trim().min(1).max(36).optional(),
});

function response(body: RestaurantSearchResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function GET(request: NextRequest) {
  const parsed = inputSchema.safeParse({
    query: request.nextUrl.searchParams.get('query') ?? '',
    external: request.nextUrl.searchParams.get('external') ?? '0',
    sessionToken: request.nextUrl.searchParams.get('sessionToken') ?? undefined,
  });
  if (!parsed.success) {
    return response({ candidates: [], googleQueried: false, attributionRequired: false, providerError: null }, 400);
  }

  const { query, external, sessionToken } = parsed.data;
  try {
    const picky = await searchDublinRestaurantsByName(query);
    if (external !== '1' || query.length < 3) {
      return response({ candidates: picky, googleQueried: false, attributionRequired: false, providerError: null });
    }
    if (!sessionToken) {
      return response({ candidates: picky, googleQueried: false, attributionRequired: false, providerError: null }, 400);
    }

    const budget = await checkPlaceLookupRateLimit(getClientIp(request), 'autocomplete');
    if (!budget.allowed) {
      return response({
        candidates: picky,
        googleQueried: false,
        attributionRequired: false,
        providerError: 'rate_limited',
      });
    }

    try {
      const google = await searchGoogleRestaurants(query, sessionToken, request.signal);
      const candidates = mergeSearchCandidates(picky, google);
      return response({
        candidates,
        googleQueried: true,
        attributionRequired: google.length > 0,
        providerError: null,
      });
    } catch (error) {
      const providerError = error instanceof GooglePlacesError && error.code === 'unavailable'
        ? 'unavailable' as const
        : 'unavailable' as const;
      console.error('[restaurant-search] Google Places failed:', error instanceof Error ? error.message : error);
      return response({ candidates: picky, googleQueried: true, attributionRequired: false, providerError });
    }
  } catch (error) {
    console.error('[restaurant-search] database search failed:', error instanceof Error ? error.message : error);
    return response({ candidates: [], googleQueried: false, attributionRequired: false, providerError: null }, 500);
  }
}
