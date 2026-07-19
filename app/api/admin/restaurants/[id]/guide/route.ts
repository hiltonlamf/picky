import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setGuideMembership, getRestaurantMeta } from '@/lib/db';

const schema = z.object({
  city: z.string().min(1).max(100),
  featured: z.boolean(),
});

// Add/remove this restaurant from a city's guide (featured_restaurants).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await setGuideMembership({ restaurantId: restaurant.id, city: parsed.data.city, featured: parsed.data.featured });
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
