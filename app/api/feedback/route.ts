import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { submitFeedback } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { ANON_ID_COOKIE } from '@/lib/telemetry';
import { hashIp, getClientIp } from '@/lib/rate-limit';

const schema = z.object({
  // Optional: guide-level feedback (suggest a restaurant / flag an issue) has no
  // single restaurant — it carries a `city` instead.
  restaurantId: z.string().uuid().optional().nullable(),
  restaurantName: z.string().max(200).optional().nullable(),
  feedbackType: z.string().min(1).max(64),
  notes: z.string().max(1000).optional().default(''),
  city: z.string().max(100).optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { restaurantId, restaurantName, feedbackType, notes, city } = parsed.data;
    const ip = getClientIp(request);
    const ipHash = hashIp(ip);
    const anonId = request.cookies.get(ANON_ID_COOKIE)?.value ?? null;

    await submitFeedback(restaurantId ?? null, restaurantName ?? null, feedbackType, notes, ipHash, anonId, city ?? null);
    // Mirrors the restaurant_feedback insert so PostHog and the DB agree.
    await captureServer(anonId ?? ipHash, 'feedback_submitted', {
      feedback_type: feedbackType,
      restaurant_id: restaurantId ?? null,
      city: city ?? null,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
