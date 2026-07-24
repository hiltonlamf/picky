import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { fetchRestaurantWithDishes } from '@/lib/db';

// The whole public restaurant page (name, dishes, classifications, menus) is
// fetched from here client-side. On Next 14 a GET route handler is cached by
// default, which served a stale snapshot after an admin edit — a rename, a
// reclassification or a removed dish would never show. Force it to always read
// live from the DB (one cheap indexed query, no AI cost).
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const restaurant = await fetchRestaurantWithDishes(params.id);
    if (!restaurant) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
    }
    return NextResponse.json(restaurant);
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
