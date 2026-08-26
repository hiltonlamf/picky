import { NextResponse } from 'next/server';
import { getRecentSearches } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** RFC-4180 quoting: a URL or error message can contain commas and quotes. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every searched URL and its outcome, as CSV.
 *
 * Exists because a table nobody can export is a table nobody uses — the same
 * mistake already noted for restaurant_feedback, where the data was collected
 * but only reachable through raw SQL in the Supabase dashboard.
 */
export async function GET() {
  const rows = await getRecentSearches(2000);

  const header = [
    'created_at',
    'url',
    'domain',
    'stage',
    'outcome',
    'dish_count',
    'category',
    'duration_ms',
    'error_code',
    'error_message',
    'anon_id',
  ];

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt,
        r.url,
        r.domain,
        r.stage,
        r.outcome,
        r.dishCount,
        r.category,
        r.durationMs,
        r.errorCode,
        r.errorMessage,
        r.anonId,
      ]
        .map(csvCell)
        .join(',')
    );
  }

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="platefully-searches-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
