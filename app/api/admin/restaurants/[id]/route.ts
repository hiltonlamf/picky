import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteRestaurant, getRestaurantMeta, renameRestaurant } from '@/lib/db';

// Permanently delete a restaurant and (via cascade) its menus, dishes, reports
// and guide entries. Admin-gated by middleware (picky_admin cookie).
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await deleteRestaurant(params.id);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(200) });

// Edit restaurant fields (currently just the name — the pipeline sometimes picks
// up the wrong one). Admin-gated by middleware.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    const restaurant = await getRestaurantMeta(params.id);
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

    await renameRestaurant(params.id, parsed.data.name);
    return NextResponse.json({ success: true, name: parsed.data.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
