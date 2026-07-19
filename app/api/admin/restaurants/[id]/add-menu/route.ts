import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { addMenuFromUrl, addMenuFromUpload, getRestaurantMeta } from '@/lib/db';

// Vercel serverless functions hard-cap the request body at 4.5MB regardless
// of app config — well under lib/ai.ts's 20MB URL-fetched PDF ceiling, so
// uploads get a tighter limit (~3MB raw, base64-inflated) to stay under it
// with room for the JSON envelope. The client enforces the same 3MB cap
// before reading the file, so this is a backstop, not the primary UX.
const MAX_BASE64_LEN = 4_200_000;

const schema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('url'),
    url: z.string().url().max(2000),
    label: z.string().min(1).max(100),
  }),
  z.object({
    mode: z.literal('upload'),
    kind: z.enum(['image', 'pdf']),
    fileBase64: z.string().min(1).max(MAX_BASE64_LEN),
    label: z.string().min(1).max(100),
  }),
]);

// The one admin action in this whole feature that spends real LLM money —
// see lib/db.ts's addMenuFromUrl/addMenuFromUpload for the extraction +
// veg-audit each runs. The UI requires an explicit confirm click before
// calling this route.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    const result =
      parsed.data.mode === 'url'
        ? await addMenuFromUrl({
            restaurantId: restaurant.id,
            restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
            restaurantName: restaurant.name,
            city: restaurant.city,
            url: parsed.data.url,
            label: parsed.data.label,
          })
        : await addMenuFromUpload({
            restaurantId: restaurant.id,
            restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
            restaurantName: restaurant.name,
            city: restaurant.city,
            kind: parsed.data.kind,
            fileBase64: parsed.data.fileBase64,
            label: parsed.data.label,
          });

    return NextResponse.json({
      success: true,
      addedDishCount: result.addedDishCount,
      costUsd: result.usage.costUsd,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
