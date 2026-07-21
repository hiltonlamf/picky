import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { addMenuFromUrl, addMenuFromUpload, getRestaurantMeta, submitFeedback } from '@/lib/db';
import { checkRateLimit, getClientIp, hashIp, MAX_SEARCHES_PER_HOUR } from '@/lib/rate-limit';
import { captureServer } from '@/lib/posthog-server';
import { ANON_ID_COOKIE } from '@/lib/telemetry';

// The PUBLIC counterpart to the admin "Add a missing menu" flow: shown on a
// restaurant's "no menu found" screen so a diner who knows where the menu lives
// can paste a direct link or upload a photo/PDF, and we read it immediately.
//
// This is the one public endpoint that spends real Anthropic money on demand,
// so it is guarded hard:
//   * a per-IP rate-limit slot is consumed up front (same budget as search) —
//     an attacker can't hammer it to run up the bill;
//   * uploads are size-capped (Vercel hard-caps the body at 4.5MB anyway) and
//     type-validated before any model call;
//   * it only accepts submissions for restaurants we FAILED on (no_menu/error),
//     so it can't be used to vandalise a restaurant that already has a menu;
//   * every submission is recorded to restaurant_feedback (wipe-safe) so a
//     genuine contribution — or an abuse pattern — is visible to the admin.
export const maxDuration = 60;

// Matches the admin add-menu cap: ~3MB raw file, base64-inflated, under Vercel's
// 4.5MB body ceiling with room for the JSON envelope.
const MAX_BASE64_LEN = 4_200_000;

const schema = z.discriminatedUnion('mode', [
  z.object({
    restaurantId: z.string().uuid(),
    mode: z.literal('url'),
    url: z.string().url().max(2000),
  }),
  z.object({
    restaurantId: z.string().uuid(),
    mode: z.literal('upload'),
    kind: z.enum(['image', 'pdf']),
    fileBase64: z.string().min(1).max(MAX_BASE64_LEN),
  }),
]);

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const distinctId = request.cookies.get(ANON_ID_COOKIE)?.value ?? hashIp(ip);
  try {
    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(parsed.data.restaurantId);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    // Only help where we failed — never let the public overwrite/append to a
    // restaurant that already has a live menu (that's what Feedback is for).
    if (restaurant.status === 'done') {
      return NextResponse.json(
        { error: 'This restaurant already has a menu. Use the Feedback button to report an issue with it.' },
        { status: 409 }
      );
    }

    // Consume a rate slot BEFORE spending any tokens (this attempt costs money
    // whether or not it succeeds).
    const { allowed } = await checkRateLimit(ip);
    if (!allowed) {
      await captureServer(distinctId, 'rate_limit_hit', { stage: 'submit_menu' });
      return NextResponse.json(
        { error: `You've reached the limit of ${MAX_SEARCHES_PER_HOUR} submissions per hour. Please try again later.` },
        { status: 429 }
      );
    }

    // Audit trail: record the submission regardless of outcome, so a real
    // contribution (or abuse) is visible in the admin feedback inbox.
    const submissionNote =
      parsed.data.mode === 'url' ? `Menu link: ${parsed.data.url}` : `Uploaded ${parsed.data.kind} menu`;
    await submitFeedback(
      restaurant.id,
      restaurant.name,
      'user_menu_submission',
      submissionNote,
      hashIp(ip),
      request.cookies.get(ANON_ID_COOKIE)?.value ?? null
    ).catch(() => {});

    const result =
      parsed.data.mode === 'url'
        ? await addMenuFromUrl({
            restaurantId: restaurant.id,
            restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
            restaurantName: restaurant.name,
            city: restaurant.city,
            url: parsed.data.url,
            label: 'Menu',
          })
        : await addMenuFromUpload({
            restaurantId: restaurant.id,
            restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
            restaurantName: restaurant.name,
            city: restaurant.city,
            kind: parsed.data.kind,
            fileBase64: parsed.data.fileBase64,
            label: 'Menu',
          });

    await captureServer(distinctId, 'user_menu_submission_succeeded', {
      restaurant_id: restaurant.id,
      mode: parsed.data.mode,
      dish_count: result.addedDishCount,
    });

    return NextResponse.json({ success: true, addedDishCount: result.addedDishCount });
  } catch (err) {
    // addMenuFrom* throws a friendly, user-facing message when it can't read a
    // menu from the supplied source — surface it so the user can try another.
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
