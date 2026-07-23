import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCityGuides, createCityGuide, addRestaurantsToGuide } from '@/lib/db';

// Reads the DB — never prerender at build time (CI has no DB creds).
export const dynamic = 'force-dynamic';

// Admin-gated by middleware.ts.

// List all city guides (with counts) for the admin guides page.
export async function GET() {
  try {
    const guides = await getCityGuides();
    return NextResponse.json({ guides });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const createSchema = z.object({
  displayName: z.string().min(1).max(80),
  country: z.string().max(80).optional().nullable(),
  // Optional initial restaurant URLs (line-separated box on the create form).
  urls: z.array(z.string().min(1).max(500)).max(200).optional(),
});

// Create a new draft city guide, optionally seeding it with restaurant URLs.
// No AI is run here — the created rows are 'pending' and the client analyses
// them one at a time via the reparse route.
export async function POST(request: NextRequest) {
  try {
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const guide = await createCityGuide({
      displayName: parsed.data.displayName,
      country: parsed.data.country ?? null,
    });

    const added = parsed.data.urls?.length ? await addRestaurantsToGuide(guide.slug, parsed.data.urls) : [];

    return NextResponse.json({ guide, added });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    // A duplicate-slug attempt is a client error, not a server fault.
    const status = /already exists/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
