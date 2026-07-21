import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { confirmNoMenu } from '@/lib/db';

// Admin confirms a "no menu / dead site" outcome. Makes it STICKY — future
// searches return the cached answer forever (no re-analysis, no AI spend),
// past the 30-day staleness window an unconfirmed no_menu would otherwise reset
// after. The reason can be re-labelled here (e.g. 'closed' for a shut place).
const schema = z.object({
  reason: z.enum(['not_listed', 'unavailable', 'closed']),
});

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    await confirmNoMenu(params.id, parsed.data.reason);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
