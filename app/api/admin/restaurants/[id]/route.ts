import { NextRequest, NextResponse } from 'next/server';
import { deleteRestaurant, getRestaurantMeta } from '@/lib/db';

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
