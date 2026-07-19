import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveFeedback } from '@/lib/db';

const schema = z.object({
  kind: z.enum(['dish_report', 'restaurant_feedback']),
  id: z.string().uuid(),
  status: z.enum(['confirmed', 'dismissed']),
  resolutionNotes: z.string().max(1000).optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    await resolveFeedback(parsed.data.kind, parsed.data.id, parsed.data.status, parsed.data.resolutionNotes ?? null);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
