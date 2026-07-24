import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { addRestaurantsToGuide, getCityGuideBySlug } from '@/lib/db';

// Admin-gated by middleware.ts.

const schema = z.object({
  urls: z.array(z.string().min(1).max(500)).min(1).max(200),
});

// Append a batch of restaurant URLs to an existing guide (the "add restaurants"
// box in the workspace — also how you add more restaurants to Dublin). No AI is
// run here; the client analyses the returned pending rows one at a time.
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const guide = await getCityGuideBySlug(params.slug);
    if (!guide) return NextResponse.json({ error: 'Guide not found' }, { status: 404 });

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const added = await addRestaurantsToGuide(guide.slug, parsed.data.urls);
    return NextResponse.json({ added });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
