import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { reportDish } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { ANON_ID_COOKIE } from '@/lib/telemetry';
import { hashIp, getClientIp, checkWriteRateLimit } from '@/lib/rate-limit';

const schema = z.object({
  dishId: z.string().uuid(),
  issueType: z.string().min(1).max(64),
  notes: z.string().max(500).optional().default(''),
  proposedClassification: z.enum(['vegan', 'vegetarian', 'neither', 'unknown']).optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { dishId, issueType, notes, proposedClassification } = parsed.data;
    const ip = getClientIp(request);
    const ipHash = hashIp(ip);
    const anonId = request.cookies.get(ANON_ID_COOKIE)?.value ?? null;

    // Unauthenticated insert: throttle so dish reports (which feed the eval
    // ground truth) can't be poisoned in bulk.
    const { allowed } = await checkWriteRateLimit(ip, 'report');
    if (!allowed) {
      return NextResponse.json(
        { error: 'Thanks — you have sent us a lot just now. Please try again a bit later.' },
        { status: 429 }
      );
    }

    await reportDish(dishId, issueType, notes, ipHash, anonId, proposedClassification ?? null);
    // Mirrors the dish_reports insert so PostHog and the DB agree.
    await captureServer(request, anonId ?? ipHash, 'dish_reported', {
      issue_type: issueType,
      dish_id: dishId,
      proposed_classification: proposedClassification ?? null,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
