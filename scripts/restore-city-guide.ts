// Rebuild a city guide's membership from the restaurants we have already
// analysed for that city.
//
// Written after the Dublin guide lost ~70 of its featured_restaurants rows on
// 2026-09-08. The restaurants and their menus were never touched — only the
// join table that decides what appears on a guide — so the guide can be
// reconstructed from the data without re-scraping or re-classifying anything.
//
// FREE: no AI calls, no scraping. It only writes featured_restaurants rows.
//
//   npx tsx scripts/restore-city-guide.ts                    # dry run, dublin
//   npx tsx scripts/restore-city-guide.ts --city amsterdam
//   npx tsx scripts/restore-city-guide.ts --apply             # execute
//
// It ADDS, never removes: an admin's existing curation is left alone, and
// re-running it is a no-op. Only restaurants that pass isPubliclyVisible are
// added, so it cannot put a broken or thin restaurant in front of a visitor.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { isPubliclyVisible, computeReviewFlags, countDishes } from '../lib/review-flags';
import { guideInsights } from '../lib/menu-insights';
import type { Restaurant, MenuSection, Dish, DietaryClassification } from '../types';

const APPLY = process.argv.includes('--apply');
const cityArg = process.argv.indexOf('--city');
const CITY = cityArg !== -1 ? process.argv[cityArg + 1] : 'dublin';

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured — check .env.local');
  return createClient(url, key);
}

/** PostgREST truncates an unpaginated select at 1000 rows, silently. */
async function selectAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

async function loadCityRestaurants(supabase: any, city: string): Promise<Restaurant[]> {
  const { data: rows, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('city', city)
    .eq('status', 'done');
  if (error) throw new Error(error.message);
  const restRows = (rows ?? []) as any[];
  if (restRows.length === 0) return [];
  const ids = restRows.map((r) => r.id);

  const sectionRows = await selectAll<any>((from, to) =>
    supabase.from('menu_sections').select('*').in('restaurant_id', ids).order('display_order').range(from, to)
  );
  const dishRows = await selectAll<any>((from, to) =>
    supabase.from('dishes').select('*').in('restaurant_id', ids).is('deleted_at', null).range(from, to)
  );

  const dishesBySection = new Map<string, Dish[]>();
  for (const d of dishRows) {
    const list = dishesBySection.get(d.section_id) ?? [];
    list.push({
      id: d.id,
      name: d.name,
      description: d.description,
      price: d.price,
      classification: d.classification as DietaryClassification,
      confidence: d.confidence,
      confidenceReason: d.confidence_reason,
      reportCount: d.report_count ?? 0,
      warningFlagged: !!d.warning_flagged,
      humanVerified: !!d.human_verified,
      origin: d.origin ?? 'ai',
      deletedAt: d.deleted_at ?? null,
    });
    dishesBySection.set(d.section_id, list);
  }
  const sectionsByRestaurant = new Map<string, MenuSection[]>();
  for (const s of sectionRows) {
    const list = sectionsByRestaurant.get(s.restaurant_id) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      displayOrder: s.display_order ?? 0,
      menuLabel: s.menu_label ?? null,
      dishes: dishesBySection.get(s.id) ?? [],
    });
    sectionsByRestaurant.set(s.restaurant_id, list);
  }

  return restRows.map((r) => ({
    ...r,
    guideApprovedAt: r.guide_approved_at ?? null,
    sections: sectionsByRestaurant.get(r.id) ?? [],
  })) as unknown as Restaurant[];
}

async function main() {
  const supabase = db();
  console.log(`${APPLY ? '⚙️  APPLY' : '🔎 DRY RUN'} — rebuild the "${CITY}" guide from analysed restaurants\n`);

  const { data: featured, error: featError } = await supabase
    .from('featured_restaurants')
    .select('restaurant_id, display_order')
    .eq('city', CITY);
  if (featError) throw new Error(`Could not read the guide: ${featError.message}`);
  const alreadyFeatured = new Set(((featured ?? []) as any[]).map((f) => f.restaurant_id as string));

  const restaurants = await loadCityRestaurants(supabase, CITY);
  const eligible = restaurants.filter(isPubliclyVisible);
  const missing = eligible.filter((r) => !alreadyFeatured.has(r.id));
  const skipped = restaurants.filter((r) => !isPubliclyVisible(r));

  console.log(`analysed (status=done): ${restaurants.length}`);
  console.log(`already on the guide:   ${alreadyFeatured.size}`);
  console.log(`eligible to show:       ${eligible.length}`);
  console.log(`to ADD:                 ${missing.length}\n`);

  if (skipped.length > 0) {
    console.log(`not eligible, left off (${skipped.length}):`);
    for (const r of skipped) {
      const flags = computeReviewFlags(r).map((f) => f.code).join(',') || 'none';
      console.log(`  ${(r.name ?? r.url).slice(0, 44).padEnd(46)} dishes=${countDishes(r)} flags=${flags}`);
    }
    console.log();
  }

  if (missing.length === 0) {
    console.log('Nothing to add — the guide already lists every eligible restaurant.');
    return;
  }

  // Highest veg count first, so display_order matches how the guide already
  // ranks. getFeaturedRestaurants re-sorts on veg anyway; this just keeps the
  // stored order sensible for the admin list.
  const ordered = missing
    .map((r) => ({ restaurant: r, veg: guideInsights(r).maxVegOptions }))
    .sort((a, b) => b.veg - a.veg);

  console.log(`will add (${ordered.length}):`);
  for (const { restaurant, veg } of ordered) {
    console.log(`  ${String(veg).padStart(3)} veggie  ${restaurant.name ?? restaurant.url}`);
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to write these rows. Nothing has been changed.');
    return;
  }

  let order = alreadyFeatured.size;
  let added = 0;
  for (const { restaurant } of ordered) {
    const { error } = await supabase
      .from('featured_restaurants')
      .upsert(
        { restaurant_id: restaurant.id, city: CITY, display_order: order++ },
        { onConflict: 'restaurant_id,city' }
      );
    if (error) {
      console.log(`  ✗ ${restaurant.name} — ${error.message}`);
      continue;
    }
    added++;
  }
  console.log(`\n✅ added ${added} restaurant(s) to the "${CITY}" guide.`);

  const { count } = await supabase
    .from('featured_restaurants')
    .select('*', { count: 'exact', head: true })
    .eq('city', CITY);
  console.log(`guide now lists ${count} restaurant(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
