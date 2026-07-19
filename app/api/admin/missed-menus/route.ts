import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { saveMissedMenus, getRestaurantMeta } from '@/lib/db';

const schema = z.object({
  restaurantId: z.string().uuid(),
  missedMenus: z.string().max(2000),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(parsed.data.restaurantId);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await saveMissedMenus({
      url: restaurant.canonicalUrl ?? restaurant.url,
      restaurantName: restaurant.name,
      city: restaurant.city,
      missedMenus: parsed.data.missedMenus,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
