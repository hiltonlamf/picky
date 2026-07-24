import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setFeaturedHidden, getCityGuideBySlug, getRestaurantMeta } from '@/lib/db';

// Admin-gated by middleware.ts.

const schema = z.object({
  restaurantId: z.string().uuid(),
  hidden: z.boolean(),
});

// Hide/unhide a restaurant from a city's PUBLIC guide while keeping it in the
// admin workspace (independent of the automatic quality gate).
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const guide = await getCityGuideBySlug(params.slug);
    if (!guide) return NextResponse.json({ error: 'Guide not found' }, { status: 404 });

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(parsed.data.restaurantId);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await setFeaturedHidden(parsed.data.restaurantId, guide.slug, parsed.data.hidden);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
