// Populate first-party addresses for one city without spending reader/LLM/API quota.
//
//   npx tsx scripts/enrich-locations.ts --city dublin
//   npx tsx scripts/enrich-locations.ts --city dublin --apply
//   npx tsx scripts/enrich-locations.ts --apply
//
// Dry-run is intentional. Each candidate gets one ordinary homepage request
// and up to three linked same-domain location-page requests.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { findLocationsOnWebsite } from '../lib/location';
import { saveRestaurantLocations } from '../lib/db';
import { MIN_GUIDE_DISHES } from '../lib/review-flags';

const cityIndex = process.argv.indexOf('--city');
const city = cityIndex === -1 ? null : process.argv[cityIndex + 1]?.trim().toLowerCase();
const apply = process.argv.includes('--apply');
const limitIndex = process.argv.indexOf('--limit');
const offsetIndex = process.argv.indexOf('--offset');
const idsIndex = process.argv.indexOf('--ids');
const limit = limitIndex === -1 ? null : Number(process.argv[limitIndex + 1]);
const offset = offsetIndex === -1 ? 0 : Number(process.argv[offsetIndex + 1]);
const requestedIds = idsIndex === -1
  ? null
  : (process.argv[idsIndex + 1] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const listOnly = process.argv.includes('--list');

if (cityIndex !== -1 && !city) throw new Error('Pass a non-empty --city <guide slug>.');
if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error('Pass a positive integer after --limit.');
if (!Number.isInteger(offset) || offset < 0) throw new Error('Pass a non-negative integer after --offset.');
if (requestedIds !== null && requestedIds.length === 0) throw new Error('Pass one or more comma-separated restaurant IDs after --ids.');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  let query = supabase
    .from('restaurants')
    .select('id, name, url, canonical_url, city')
    .eq('status', 'done')
    .order('created_at');
  if (city) query = query.ilike('city', city);
  if (requestedIds) query = query.in('id', requestedIds);
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
  const eligibleRestaurants = (data ?? []).filter((restaurant) =>
    eligibleCity.has(restaurant.city as string) && (dishCounts.get(restaurant.id as string) ?? 0) >= MIN_GUIDE_DISHES
  );
  const restaurants = limit === null ? eligibleRestaurants.slice(offset) : eligibleRestaurants.slice(offset, offset + limit);

  if (listOnly) {
    console.log(JSON.stringify(eligibleRestaurants.map((restaurant) => ({ id: restaurant.id, name: restaurant.name, city: restaurant.city }))));
    return;
  }

  const scope = city ?? 'all cities';
  const batch = limit === null ? '' : `; batch offset ${offset}, limit ${limit}`;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — first-party location enrichment for ${scope} (${restaurants.length} of ${eligibleRestaurants.length} eligible restaurants${batch}; ${(data?.length ?? 0) - eligibleRestaurants.length} skipped because they are unassigned or have fewer than ${MIN_GUIDE_DISHES} live dishes)`);
  let found = 0;
  let failed = 0;
  for (const restaurant of restaurants) {
    // The submitted URL is normally the restaurant homepage. Some older rows
    // have a menu subpage in canonical_url, which would hide a footer/contact
    // address from the first-party check.
    const url = (restaurant.url as string) ?? (restaurant.canonical_url as string);
    const name = (restaurant.name as string | null) ?? url;
    try {
      const candidates = (await findLocationsOnWebsite(url)).filter((candidate) => candidate.address);
      if (!candidates.length) {
        console.log(`  no location: ${name}`);
      } else {
        found += candidates.length;
        for (const candidate of candidates) {
          console.log(`  ${apply ? 'saved' : 'would save'}: ${name} — ${candidate.address} (${candidate.source}, ${candidate.confidence})`);
        }
        if (apply) await saveRestaurantLocations(restaurant.id as string, candidates);
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : 'unknown error';
      console.log(`  skipped: ${name} — ${message}`);
    }
    // Be a considerate website visitor. This is intentionally slow and bounded.
    await sleep(500);
  }
  console.log(`\n${found} branch address(es) ${apply ? 'saved' : 'found'}; ${failed} restaurant(s) skipped; no paid APIs were called.`);
  if (!apply) console.log('Review the output, then re-run with --apply to persist these values.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
