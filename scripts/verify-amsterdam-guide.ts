/**
 * One-off verification for the city-guides feature. Exercises the REAL flow
 * end-to-end against a couple of Amsterdam (Dutch/multilingual) sites:
 *   create guide → add URLs → run the pipeline → inspect results.
 *
 * Checks specifically: (a) restaurants created + featured under 'amsterdam',
 * (b) the pipeline runs and saves dishes, (c) detected menu_language is
 * persisted, (d) for Dutch-only menus, dish descriptions carry an English
 * translation, and (e) reconciles spend against ai_usage_log.
 *
 * Spends real AI money (~$0.10–0.30 for 2 sites). Gated behind --yes.
 * Leaves the 'amsterdam' guide as a DRAFT for the founder to continue.
 *
 *   npx tsx scripts/verify-amsterdam-guide.ts --yes
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import {
  createCityGuide,
  getCityGuideBySlug,
  addRestaurantsToGuide,
  getFeaturedRestaurants,
} from '../lib/db';
import { parseAndSave } from '../lib/init-dublin';

const URLS = ['https://restaurantblauw.nl/', 'https://ramen-ya.nl/'];

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function spendTotal(): Promise<number> {
  const { data } = await db().from('ai_usage_log').select('cost_usd');
  return (data ?? []).reduce((n, r) => n + (Number((r as { cost_usd: number }).cost_usd) || 0), 0);
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log('Dry run. This spends real AI money. Re-run with --yes to execute.');
    console.log('URLs:', URLS.join(', '));
    return;
  }

  const before = await spendTotal();

  // 1. Ensure the amsterdam guide exists (draft).
  let guide = await getCityGuideBySlug('amsterdam');
  if (!guide) {
    guide = await createCityGuide({ displayName: 'Amsterdam', country: 'Netherlands' });
    console.log(`Created draft guide: ${guide.slug}`);
  } else {
    console.log(`Reusing existing guide: ${guide.slug} (${guide.status})`);
  }

  // 2. Add the URLs (creates + features; no AI).
  const added = await addRestaurantsToGuide('amsterdam', URLS);
  console.log('\nAdd results:');
  for (const a of added) console.log(`  ${a.outcome.padEnd(9)} ${a.url}  ${a.restaurantId ?? ''}`);

  // 3. Analyze each that needs it — the same pipeline the reparse route runs.
  const toAnalyze = added.filter((a) => a.needsAnalysis && a.restaurantId);
  for (const a of toAnalyze) {
    console.log(`\nAnalyzing ${a.url} …`);
    try {
      await parseAndSave(a.restaurantId!, a.url, a.url);
    } catch (err) {
      console.log(`  pipeline error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4. Inspect.
  const restaurants = await getFeaturedRestaurants('amsterdam', { includeHidden: true });
  console.log('\n=== Amsterdam guide contents ===');
  for (const r of restaurants) {
    const dishes = r.sections.flatMap((s) => s.dishes).filter((d) => !d.deletedAt);
    console.log(`\n• ${r.name ?? r.url}`);
    console.log(`  status=${r.status}  dishes=${dishes.length}  language=${r.menuLanguage ?? '—'}`);
    for (const d of dishes.slice(0, 4)) {
      console.log(`    - ${d.name}  [${d.classification}]`);
      if (d.description) console.log(`        ${d.description.slice(0, 140)}`);
    }
  }

  const after = await spendTotal();
  console.log(`\n=== Spend (ai_usage_log) this run: $${(after - before).toFixed(4)} ===`);
  console.log('Guide left as DRAFT. Review/preview/publish from /admin/guides/amsterdam');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
