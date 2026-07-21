import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { setGuideApproval, getRestaurantMeta } from '@/lib/db';

const schema = z.object({ approved: z.boolean() });

// Approve / un-approve a review-flagged restaurant for public display. Admin-
// gated by middleware (picky_admin cookie).
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await setGuideApproval(params.id, parsed.data.approved);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
