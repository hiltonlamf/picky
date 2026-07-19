import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { applyDishVerdict, getRestaurantMeta } from '@/lib/db';

const schema = z.object({
  restaurantId: z.string().uuid(),
  action: z.enum(['upsert', 'delete', 'restore']),
  dishId: z.string().uuid().optional().nullable(),
  sectionId: z.string().uuid().optional().nullable(),
  sectionName: z.string().max(200).optional().nullable(),
  menuLabel: z.string().max(200).optional().nullable(),
  name: z.string().min(1).max(300).optional(),
  classification: z.enum(['vegan', 'vegetarian', 'neither', 'unknown']).optional(),
  aiOriginalClassification: z.enum(['vegan', 'vegetarian', 'neither', 'unknown']).optional().nullable(),
  confidence: z.number().min(0).max(1).optional(),
  reviewerNotes: z.string().max(500).optional().nullable(),
  source: z.enum(['admin_review', 'feedback_confirmed']).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }

    // Server is the source of truth for identity fields (url/name/city) —
    // never trust client-supplied copies for what keys the eval_case.
    const restaurant = await getRestaurantMeta(parsed.data.restaurantId);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    const result = await applyDishVerdict({
      restaurantId: restaurant.id,
      restaurantUrl: restaurant.canonicalUrl ?? restaurant.url,
      restaurantName: restaurant.name,
      city: restaurant.city,
      action: parsed.data.action,
      dishId: parsed.data.dishId ?? null,
      sectionId: parsed.data.sectionId ?? null,
      sectionName: parsed.data.sectionName ?? null,
      menuLabel: parsed.data.menuLabel ?? null,
      name: parsed.data.name,
      classification: parsed.data.classification,
      aiOriginalClassification: parsed.data.aiOriginalClassification ?? null,
      confidence: parsed.data.confidence,
      reviewerNotes: parsed.data.reviewerNotes ?? null,
      source: parsed.data.source,
    });

    return NextResponse.json({ success: true, dishId: result.dishId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
