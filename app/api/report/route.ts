import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { reportDish } from '@/lib/db';
import { hashIp, getClientIp } from '@/lib/rate-limit';

const schema = z.object({
  dishId: z.string().uuid(),
  issueType: z.string().min(1).max(64),
  notes: z.string().max(500).optional().default(''),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { dishId, issueType, notes } = parsed.data;
    const ip = getClientIp(request);
    const ipHash = hashIp(ip);

    await reportDish(dishId, issueType, notes, ipHash);
    return NextResponse.json({ success: true });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
