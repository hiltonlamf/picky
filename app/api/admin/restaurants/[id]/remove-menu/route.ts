import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { removeMenu, getRestaurantMeta } from '@/lib/db';

const schema = z.object({
  menuLabel: z.string().max(200).nullable(),
});

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    const result = await removeMenu({
      restaurantId: restaurant.id,
      restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
      restaurantName: restaurant.name,
      city: restaurant.city,
      menuLabel: parsed.data.menuLabel,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
