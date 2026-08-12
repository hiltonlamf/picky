// Populate first-party addresses for one city without spending reader/LLM/API quota.
//
//   npx tsx scripts/enrich-locations.ts --city dublin
//   npx tsx scripts/enrich-locations.ts --city dublin --apply
//   npx tsx scripts/enrich-locations.ts --apply
//
// Dry-run is intentional. Each candidate gets at most two ordinary HTTP
// requests: its homepage and, only when needed, one same-domain Contact page.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { findLocationOnWebsite, isCandidateInCity } from '../lib/location';
import { saveRestaurantLocation } from '../lib/db';
import { MIN_GUIDE_DISHES } from '../lib/review-flags';

const cityIndex = process.argv.indexOf('--city');
const city = cityIndex === -1 ? null : process.argv[cityIndex + 1]?.trim().toLowerCase();
const apply = process.argv.includes('--apply');

if (cityIndex !== -1 && !city) throw new Error('Pass a non-empty --city <guide slug>.');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  let query = supabase
    .from('restaurants')
    .select('id, name, url, canonical_url, city')
    .eq('status', 'done')
    .is('address', null)
    .order('created_at');
  if (city) query = query.ilike('city', city);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const eligibleCity = new Set((data ?? []).map((restaurant) => restaurant.city as string).filter((value) => value && value !== 'unassigned'));
  const restaurantIds = (data ?? []).map((restaurant) => restaurant.id as string);
  const dishCounts = new Map<string, number>();
  for (let start = 0; start < restaurantIds.length; start += 200) {
    const { data: dishes, error: dishError } = await supabase
      .from('dishes')
      .select('restaurant_id')
      .in('restaurant_id', restaurantIds.slice(start, start + 200))
      .is('deleted_at', null);
    if (dishError) throw new Error(dishError.message);
    for (const dish of dishes ?? []) {
      const restaurantId = dish.restaurant_id as string;
      dishCounts.set(restaurantId, (dishCounts.get(restaurantId) ?? 0) + 1);
    }
  }
  const restaurants = (data ?? []).filter((restaurant) =>
    eligibleCity.has(restaurant.city as string) && (dishCounts.get(restaurant.id as string) ?? 0) >= MIN_GUIDE_DISHES
  );

  const scope = city ?? 'all cities';
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — first-party location enrichment for ${scope} (${restaurants.length} eligible restaurants; ${Math.max(0, (data?.length ?? 0) - restaurants.length)} skipped because they are unassigned or have fewer than ${MIN_GUIDE_DISHES} live dishes)`);
  let found = 0;
  let rejected = 0;
  let failed = 0;
  for (const restaurant of restaurants) {
    const url = (restaurant.canonical_url as string | null) ?? (restaurant.url as string);
    const name = (restaurant.name as string | null) ?? url;
    const restaurantCity = restaurant.city as string;
    try {
      const candidate = await findLocationOnWebsite(url);
      if (!candidate) {
        console.log(`  no location: ${name}`);
      } else if (!candidate.address) {
        rejected++;
        console.log(`  rejected without a verifiable city address: ${name} — coordinates only`);
      } else if (!isCandidateInCity(candidate, restaurantCity)) {
        rejected++;
        console.log(`  rejected outside ${restaurantCity}: ${name} — ${candidate.address || 'coordinates only'}`);
      } else {
        found++;
        console.log(`  ${apply ? 'saved' : 'would save'}: ${name} — ${candidate.address || 'coordinates only'} (${candidate.source}, ${candidate.confidence})`);
        if (apply) await saveRestaurantLocation(restaurant.id as string, candidate);
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : 'unknown error';
      console.log(`  skipped: ${name} — ${message}`);
    }
    // Be a considerate website visitor. This is intentionally slow and bounded.
    await sleep(500);
  }
  console.log(`\n${found} location candidate(s) ${apply ? 'saved' : 'found'}; ${rejected} candidate(s) rejected because their city could not be verified; ${failed} restaurant(s) skipped; no paid APIs were called.`);
  if (!apply) console.log('Review the output, then re-run with --apply to persist these values.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
