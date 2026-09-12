import { NextRequest, NextResponse } from 'next/server';
import { reanalyseRestaurant } from '@/lib/reanalyse';

// Admin-triggered re-run of the full pipeline for one restaurant already in
// the database (e.g. after a prompt/extraction fix, to pick up the new
// behaviour without waiting for the public flow's staleness window). Unlike
// the public /api/parse/discover + /analyze pair, this is a single blocking
// request — no per-IP rate limit (admin-only, gated by middleware.ts) and no
// resumable multi-request chain, since that machinery exists only to fit the
// public flow's serverless time cap on heavy sites. Same 60s Vercel Hobby cap
// still applies; this accepts the same overrun risk the public discover
// route's degraded inline-analysis fallback already accepts.
//
// The work itself lives in lib/reanalyse.ts so that a WHOLE-GUIDE batch (which
// needs ~30 minutes and therefore cannot run in a Vercel function at all — see
// scripts/analyze-guide-queue.ts) analyses restaurants through exactly the same
// code path as this button. Two copies would drift, and the thing they would
// drift on is the no_menu verdict we publish about a real restaurant.
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const result = await reanalyseRestaurant(params.id);

  if (result.notFound) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
  if (result.outcome === 'error') return NextResponse.json({ error: result.message }, { status: 500 });

  return NextResponse.json({
    outcome: result.outcome,
    ...(result.dishCount !== undefined ? { dishCount: result.dishCount } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  });
}
