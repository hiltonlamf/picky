import { NextResponse } from 'next/server';
import { getEvalCases, getEvalCaseDetail } from '@/lib/db';

// Reuses the exact CSV-escaping convention already in scripts/backup-spend.ts
// rather than inventing a new one or adding a CSV dependency.
const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

const HEADER = [
  'eval_case_url',
  'restaurant_name',
  'city',
  'record_type', // dish | menu_candidate | missed_menu
  'menu_label',
  'section_name',
  'dish_name',
  'expected_classification',
  'menu_verdict',
  'notes',
  'source',
  'created_at',
];

export async function GET() {
  const cases = await getEvalCases();
  const rows: string[] = [HEADER.join(',')];

  for (const c of cases) {
    const detail = await getEvalCaseDetail(c.id);
    if (!detail) continue;

    for (const d of detail.dishes) {
      rows.push(
        [
          c.url,
          c.name ?? '',
          c.city ?? '',
          'dish',
          d.menuLabel ?? '',
          d.sectionName ?? '',
          d.name,
          d.expectedClassification,
          '',
          d.notes ?? '',
          d.source,
          d.createdAt,
        ]
          .map(esc)
          .join(',')
      );
    }

    for (const mc of detail.menuCandidates) {
      rows.push(
        [c.url, c.name ?? '', c.city ?? '', 'menu_candidate', mc.label, '', '', '', mc.verdict, mc.notes ?? '', '', mc.createdAt]
          .map(esc)
          .join(',')
      );
    }

    if (c.missedMenus) {
      rows.push(
        [c.url, c.name ?? '', c.city ?? '', 'missed_menu', '', '', '', '', '', c.missedMenus, '', c.createdAt]
          .map(esc)
          .join(',')
      );
    }
  }

  const csv = rows.join('\n') + '\n';
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="picky-eval-set-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
