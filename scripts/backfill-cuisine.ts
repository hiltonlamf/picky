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
import Anthropic from '@anthropic-ai/sdk';

const APPLY = process.argv.includes('--yes');
const ALL = process.argv.includes('--all');

// Haiku — cheapest tier; mirrors EXTRACTION_MODEL in lib/ai.ts.
const MODEL = 'claude-haiku-4-5-20251001';
const PRICE = { input: 1.0, output: 5.0 }; // $/million tokens

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function cuisineFor(client: Anthropic, name: string, sections: string[], dishes: string[]) {
  const prompt =
    `Restaurant: ${name || 'unknown'}\n` +
    `Menu sections: ${sections.join(', ') || 'unknown'}\n` +
    `Example dishes: ${dishes.slice(0, 8).join(', ') || 'unknown'}\n\n` +
    `Reply with ONLY the cuisine type in 1-2 words (e.g. Italian, Indian, Chinese, Thai, ` +
    `Modern European, Seafood, Mexican). No punctuation, no other text.`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 12,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const cuisine = text.replace(/[."']/g, '').split('\n')[0].trim().slice(0, 40);
  const cost = (res.usage.input_tokens * PRICE.input + res.usage.output_tokens * PRICE.output) / 1_000_000;
  return { cuisine, cost, tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens };
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

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let total = 0;
  for (const r of rows) {
    const { data: secs } = await supabase.from('menu_sections').select('name').eq('restaurant_id', r.id);
    const { data: dsh } = await supabase
      .from('dishes').select('name').eq('restaurant_id', r.id).is('deleted_at', null).limit(8);
    const sections = (secs ?? []).map((s) => s.name as string);
    const dishes = (dsh ?? []).map((d) => d.name as string);
    try {
      const { cuisine, cost, tokensIn, tokensOut } = await cuisineFor(client, r.name ?? '', sections, dishes);
      total += cost;
      await supabase.from('restaurants').update({ cuisine }).eq('id', r.id);
      // Keep the append-only spend history consistent (no FK, wipe-safe).
      await supabase.from('ai_usage_log').insert({
        restaurant_id: r.id, restaurant_name: r.name, url: r.url,
        model_used: MODEL, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost,
      });
      console.log(`  ✓ ${r.name ?? r.url} → ${cuisine}  ($${cost.toFixed(5)})`);
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
