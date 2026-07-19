import { NextResponse } from 'next/server';
import { getCorrectionLog } from '@/lib/db';

export const dynamic = 'force-dynamic';

// A human-and-Claude-readable Markdown report of every AI mistake a reviewer has
// corrected — meant to be handed to Claude Code to fix the pipeline (prompts in
// lib/ai.ts) at the root, instead of correcting dishes one at a time.
export async function GET() {
  const log = await getCorrectionLog();

  const lines: string[] = [];
  lines.push('# Picky — AI Error Log');
  lines.push('');
  lines.push(`Generated: ${log.generatedAt}`);
  lines.push('');
  lines.push(
    'Every case below is one where a human reviewer corrected the AI, drawn from the human-verified golden set. ' +
      'Use it to find *systematic* errors in the extraction/classification pipeline (see `lib/ai.ts` and its prompts) ' +
      'and reduce recurrence — look for patterns across cases, not one-off fixes.'
  );
  lines.push('');

  // 1. Dish misclassifications
  const unsafe = log.dishErrors.filter((e) => e.shouldBe === 'neither' && (e.aiSaid === 'vegan' || e.aiSaid === 'vegetarian'));
  lines.push(`## 1. Dish misclassifications — ${log.dishErrors.length} case(s)`);
  lines.push('');
  if (unsafe.length > 0) {
    lines.push(
      `> ⚠️ ${unsafe.length} of these are UNSAFE: the AI called a non-vegetarian dish vegan/vegetarian. ` +
        'These are the trust-breaking errors — prioritise them.'
    );
    lines.push('');
  }
  if (log.dishErrors.length === 0) {
    lines.push('_None recorded yet._');
  } else {
    lines.push('Format: dish — AI said **X**, should be **Y** [restaurant] (menu / section) — note');
    lines.push('');
    for (const e of log.dishErrors) {
      const where = [e.menuLabel, e.sectionName].filter(Boolean).join(' / ');
      const flag = e.shouldBe === 'neither' && (e.aiSaid === 'vegan' || e.aiSaid === 'vegetarian') ? '⚠️ ' : '';
      lines.push(
        `- ${flag}"${e.name}" — AI said **${e.aiSaid}**, should be **${e.shouldBe}** ` +
          `[${e.restaurantName ?? e.url}]${where ? ` (${where})` : ''}${e.notes ? ` — ${e.notes}` : ''}`
      );
    }
  }
  lines.push('');

  // 2. Discovery mistakes
  const spuriousTotal = log.discovery.reduce((n, d) => n + d.spurious.length, 0);
  const duplicateTotal = log.discovery.reduce((n, d) => n + d.duplicate.length, 0);
  const missedTotal = log.discovery.filter((d) => d.missedMenus).length;
  lines.push(
    `## 2. Menu-discovery mistakes — ${spuriousTotal} spurious, ${duplicateTotal} duplicate, ${missedTotal} with missed menus`
  );
  lines.push('');
  if (log.discovery.length === 0) {
    lines.push('_None recorded yet._');
  } else {
    for (const d of log.discovery) {
      lines.push(`### ${d.restaurantName ?? d.url}`);
      lines.push(`URL: ${d.url}`);
      if (d.spurious.length) lines.push(`- Wrongly treated as a menu (spurious): ${d.spurious.map((s) => `"${s}"`).join(', ')}`);
      if (d.duplicate.length) lines.push(`- Double-counted (duplicate): ${d.duplicate.map((s) => `"${s}"`).join(', ')}`);
      if (d.missedMenus) lines.push(`- Real menus the AI missed entirely: ${d.missedMenus}`);
      lines.push('');
    }
  }

  // 3. Hallucinated dishes
  lines.push(`## 3. Hallucinated dishes (AI invented a dish that isn't real) — ${log.hallucinatedDishes.length} case(s)`);
  lines.push('');
  if (log.hallucinatedDishes.length === 0) {
    lines.push('_None recorded yet._');
  } else {
    for (const h of log.hallucinatedDishes) {
      lines.push(`- "${h.name}" [${h.restaurantName ?? h.url}]`);
    }
  }
  lines.push('');

  const body = lines.join('\n');
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="picky-ai-error-log-${new Date().toISOString().slice(0, 10)}.md"`,
    },
  });
}
