// Seed the Dublin guide with trendy/popular restaurants by running each one
// through the EXISTING analysis engine (the same path a user search triggers) —
// scrape → discover → extract → classify → save. No new analyzer.
//
// Costs real Anthropic money, so it is gated behind --yes. Without it, the
// script only prints the plan (what it would do) and exits — no spend.
//
//   npx tsx scripts/seed-trendy-dublin.ts                 # dry plan, no spend
//   npx tsx scripts/seed-trendy-dublin.ts --yes --limit 10   # PILOT: first 10
//   npx tsx scripts/seed-trendy-dublin.ts --yes              # full run
//
// A restaurant is only added to the public guide (featured) if it comes back
// `done` with at least MIN_GUIDE_DISHES dishes. Anything that errors or is too
// thin is left analysed-but-unfeatured and printed in the failure summary — the
// AI-flow debug queue.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { createRestaurantRecord, findExistingRestaurant, fetchRestaurantWithDishes } from '../lib/db';
import { parseAndSave, upsertFeatured } from '../lib/init-dublin';
import { countDishes, computeReviewFlags, MIN_GUIDE_DISHES } from '../lib/review-flags';

const APPLY = process.argv.includes('--yes');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Trendy/popular Dublin restaurants with confirmed official websites (root
// domains — the pipeline discovers the menu page itself). Ordered buzziest-first
// so a --limit pilot hits the strongest candidates. Existing seeds are omitted;
// the dedup layer would collapse any overlap anyway.
const TRENDY_DUBLIN: { name: string; url: string }[] = [
  { name: 'Allta', url: 'https://allta.ie' },
  { name: 'SOLE Seafood & Grill', url: 'https://sole.ie' },
  { name: 'Amai by Viktor', url: 'https://amaibyviktor.ie' },
  { name: 'Hawker', url: 'https://hawkerchinese.com' },
  { name: 'Grano', url: 'https://grano.ie' },
  { name: 'Fish Shop', url: 'https://fish-shop.ie' },
  { name: 'Bar Pez', url: 'https://barpez.ie' },
  { name: 'Glovers Alley', url: 'https://gloversalley.com' },
  { name: 'Hang Dai', url: 'https://hangdaichinese.com' },
  { name: 'Mr Fox', url: 'https://mrfox.ie' },
  { name: 'Dax', url: 'https://dax.ie' },
  { name: 'Shouk', url: 'https://shouk.ie' },
  { name: 'Featherblade', url: 'https://featherblade.ie' },
  { name: 'Drury Buildings', url: 'https://drurybuildings.com' },
  { name: 'Sprezzatura', url: 'https://sprezzaturadublin.ie' },
  { name: "Bibi's", url: 'https://bibis.ie' },
  { name: 'Clanbrassil House', url: 'https://clanbrassilhouse.com' },
  { name: 'Old Street', url: 'https://oldstreet.ie' },
  { name: 'Pichet', url: 'https://pichet.ie' },
  { name: 'Fade Street Social', url: 'https://fadestreetsocial.com' },
  { name: "The Pig's Ear", url: 'https://thepigsear.ie' },
  { name: 'Ananda', url: 'https://anandarestaurant.ie' },
  { name: 'Rasam', url: 'https://rasam.ie' },
  { name: "Kicky's", url: 'https://kickys.ie' },
];

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function nextFeaturedOrder(supabase: ReturnType<typeof db>): Promise<number> {
  const { data } = await supabase
    .from('featured_restaurants')
    .select('display_order')
    .eq('city', 'dublin')
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as { display_order: number } | null)?.display_order ?? -1) + 1;
}

async function main() {
  const list = TRENDY_DUBLIN.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const supabase = db();
  const runStart = new Date().toISOString();

  if (!APPLY) {
    console.log(`🔎 PLAN (no spend) — would analyse ${list.length} restaurant(s) via the live engine:\n`);
    list.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} — ${r.url}`));
    console.log('\nEach runs the full pipeline (real Anthropic cost). Re-run with --yes to execute.');
    console.log('Pilot suggestion: --yes --limit 10');
    return;
  }

  console.log(`⚙️  Analysing ${list.length} restaurant(s) through the live engine. This spends real money.\n`);

  const passed: Array<{ name: string; dishes: number }> = [];
  const failed: Array<{ name: string; reason: string }> = [];
  let order = await nextFeaturedOrder(supabase);

  for (const { name, url } of list) {
    process.stdout.write(`• ${name} (${url}) … `);
    try {
      // Reuse existing rows; only (re)analyse when not already done — saves spend.
      const existing = await findExistingRestaurant(url);
      let id: string;
      if (existing) {
        id = existing.id;
        if (existing.status !== 'done') {
          await parseAndSave(id, name, url);
        }
      } else {
        id = await createRestaurantRecord(url);
        await supabase.from('restaurants').update({ name }).eq('id', id);
        await parseAndSave(id, name, url);
      }

      const r = await fetchRestaurantWithDishes(id);
      if (!r) throw new Error('row vanished after analysis');
      const dishes = countDishes(r);
      const flags = computeReviewFlags(r);

      if (r.status === 'done' && dishes >= MIN_GUIDE_DISHES) {
        await upsertFeatured(id, order++);
        const flagNote = flags.length ? ` [⚠ ${flags.map((f) => f.code).join(',')} — held for review]` : '';
        console.log(`✓ done, ${dishes} dishes — featured${flagNote}`);
        passed.push({ name, dishes });
      } else {
        const reason = r.status !== 'done' ? `status ${r.status}` : `only ${dishes} dishes`;
        console.log(`✗ ${reason} — NOT featured`);
        failed.push({ name, reason });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      console.log(`✗ error: ${reason}`);
      failed.push({ name, reason });
    }
  }

  // End-to-end spend for this run (successes AND failed retry ladders both log
  // to ai_usage_log). Reconcile against the Anthropic Console balance.
  const { data: usage } = await supabase.from('ai_usage_log').select('cost_usd').gte('created_at', runStart);
  const spend = (usage ?? []).reduce((s, u) => s + (Number(u.cost_usd) || 0), 0);

  console.log(`\n──────── SUMMARY ────────`);
  console.log(`Featured (passed ≥${MIN_GUIDE_DISHES} dishes): ${passed.length}`);
  passed.forEach((p) => console.log(`   ✓ ${p.name} (${p.dishes})`));
  console.log(`Skipped (error / too thin) — DEBUG THESE: ${failed.length}`);
  failed.forEach((f) => console.log(`   ✗ ${f.name} — ${f.reason}`));
  console.log(`\nLogged AI spend this run: $${spend.toFixed(4)} (verify against the Console balance).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
