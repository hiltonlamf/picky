import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setCityGuidePublished, getCityGuideBySlug } from '@/lib/db';

// Admin-gated by middleware.ts.

const schema = z.object({ published: z.boolean() });

// Publish (make /[city] publicly reachable) or unpublish (back to draft) a guide.
export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const guide = await getCityGuideBySlug(params.slug);
    if (!guide) return NextResponse.json({ error: 'Guide not found' }, { status: 404 });

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    await setCityGuidePublished(guide.slug, parsed.data.published);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
