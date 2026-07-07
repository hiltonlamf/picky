import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { saveNpsResponse } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { ANON_ID_COOKIE } from '@/lib/telemetry';
import { hashIp, getClientIp } from '@/lib/rate-limit';

const schema = z.object({
  score: z.number().int().min(0).max(10),
  notes: z.string().max(1000).optional().default(''),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { score, notes } = parsed.data;
    const anonId = request.cookies.get(ANON_ID_COOKIE)?.value ?? null;

    await saveNpsResponse(anonId, score, notes);
    // Mirrors the nps_responses insert so PostHog and the DB agree.
    await captureServer(anonId ?? hashIp(getClientIp(request)), 'nps_submitted', { score });
    return NextResponse.json({ success: true });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
