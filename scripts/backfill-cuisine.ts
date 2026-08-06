// One-time backfill: set restaurants.cuisine for existing rows that don't have
// it yet. New restaurants get cuisine free from the extraction prompt; this fills
// in the ones analysed before that field existed.
//
// Uses ONE tiny Haiku call per restaurant (name + section names + a few dish
// names → cuisine), no re-scrape. Cost is a fraction of a cent each. Gated by
// --yes; without it, prints the plan and exits.
//
//   npx tsx scripts/backfill-cuisine.ts            # dry plan, no spend
//   npx tsx scripts/backfill-cuisine.ts --yes      # execute
//   npx tsx scripts/backfill-cuisine.ts --yes --all # also re-do ones already set
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { callClaude, EXTRACTION_MODEL, usageOf } from '../lib/ai';
import { withSpendContext } from '../lib/ai-spend';

const APPLY = process.argv.includes('--yes');
const ALL = process.argv.includes('--all');

// Haiku — the cheapest tier, and the same constant extraction uses, so a model
// change here can't silently diverge from the pipeline's.
const MODEL = EXTRACTION_MODEL;

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function cuisineFor(name: string, sections: string[], dishes: string[]) {
  const prompt =
    `Restaurant: ${name || 'unknown'}\n` +
    `Menu sections: ${sections.join(', ') || 'unknown'}\n` +
    `Example dishes: ${dishes.slice(0, 8).join(', ') || 'unknown'}\n\n` +
    `Reply with ONLY the cuisine type in 1-2 words (e.g. Italian, Indian, Chinese, Thai, ` +
    `Modern European, Seafood, Mexican). No punctuation, no other text.`;
  // Through callClaude, not the raw client: it writes the ai_usage_log row the
  // moment the API answers. Doing it by hand afterwards meant a call that was
  // billed and then threw recorded nothing, and it kept a second copy of the
  // price table that would drift the day Haiku's rate changed.
  const res = await callClaude({
    model: MODEL,
    max_tokens: 12,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const cuisine = text.replace(/[."']/g, '').split('\n')[0].trim().slice(0, 40);
  return { cuisine, usage: usageOf(res) };
}

async function main() {
  const supabase = db();
  let q = supabase.from('restaurants').select('id, name, url, cuisine').eq('status', 'done');
  if (!ALL) q = q.is('cuisine', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; name: string | null; url: string; cuisine: string | null }>;

  console.log(`${APPLY ? '⚙️  APPLY' : '🔎 DRY RUN'} — ${rows.length} restaurant(s) ${ALL ? '(all done)' : 'missing cuisine'}\n`);
  if (rows.length === 0) return;
  if (!APPLY) {
    rows.forEach((r) => console.log(`  ${r.name ?? r.url}`));
    console.log('\nRe-run with --yes to classify (one tiny Haiku call each; ~cents total).');
    return;
  }

  let total = 0;
  for (const r of rows) {
    const { data: secs } = await supabase.from('menu_sections').select('name').eq('restaurant_id', r.id);
    const { data: dsh } = await supabase
      .from('dishes').select('name').eq('restaurant_id', r.id).is('deleted_at', null).limit(8);
    const sections = (secs ?? []).map((s) => s.name as string);
    const dishes = (dsh ?? []).map((d) => d.name as string);
    try {
      // The context is what attributes the logged row to this restaurant.
      const { cuisine, usage } = await withSpendContext(
        { restaurantId: r.id, url: r.url, restaurantName: r.name },
        () => cuisineFor(r.name ?? '', sections, dishes)
      );
      total += usage.costUsd;
      await supabase.from('restaurants').update({ cuisine }).eq('id', r.id);
      console.log(`  ✓ ${r.name ?? r.url} → ${cuisine}  ($${usage.costUsd.toFixed(5)})`);
    } catch (err) {
      console.log(`  ✗ ${r.name ?? r.url} — ${err instanceof Error ? err.message : 'failed'}`);
    }
  }
  console.log(`\nDone. Logged AI spend: $${total.toFixed(4)}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
