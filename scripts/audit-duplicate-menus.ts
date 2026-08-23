// Audit menus that are really the same menu shown twice, across every
// analysed restaurant.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping. It re-reads what
// is already in the database and compares dish-name sets, so it can be run as
// often as you like.
//
//   npx tsx scripts/audit-duplicate-menus.ts             # exact duplicates
//   npx tsx scripts/audit-duplicate-menus.ts --near      # also near-duplicates
//
// Why this exists: a restaurant showing "À la carte" and "Early Bird" as two
// options containing the identical 42 dishes reads as broken software, and it
// is founder priority ① (the right menus, no more and no fewer).
//
// NOTHING here is deleted, and nothing in the pipeline deletes it either.
// Founder's rule (2026-08-23): "some restaurants just have multiple menus of
// very similar dishes... it is very possible that a lunch menu is just a
// reduced version of a dinner menu. That's something to flag but not delete."
// Overlapping menus raise a duplicate_menu review flag (lib/review-flags.ts)
// that withholds the restaurant until a human decides.
//
// A pair reported as EXACT is usually the tell for an extraction bug — the same
// page read twice under two names — so it is worth chasing at the source rather
// than papering over. --near also lists pairs that merely overlap heavily.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';

const near = process.argv.includes('--near');
/** Below this, two menus sharing a dish list is coincidence, not duplication. */
const MIN_DISHES = 3;
const NEAR_THRESHOLD = 0.9;

const normName = (name: string): string =>
  name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: restaurants, error } = await supabase
    .from('restaurants')
    .select('id, name, city')
    .eq('status', 'done');
  if (error) throw new Error(error.message);

  const nameById = new Map((restaurants ?? []).map((r) => [r.id as string, r.name as string]));
  const cityById = new Map((restaurants ?? []).map((r) => [r.id as string, r.city as string]));
  const ids = Array.from(nameById.keys());

  // Chunked: PostgREST caps rows per response, and `.in()` lists get unwieldy.
  const sections: Array<{ id: string; restaurant_id: string; menu_label: string | null }> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error: sectionError } = await supabase
      .from('menu_sections')
      .select('id, restaurant_id, menu_label')
      .in('restaurant_id', ids.slice(i, i + 50));
    if (sectionError) throw new Error(sectionError.message);
    sections.push(...((data ?? []) as typeof sections));
  }

  const sectionIds = sections.map((s) => s.id);
  const dishes: Array<{ section_id: string; name: string }> = [];
  for (let i = 0; i < sectionIds.length; i += 200) {
    const { data, error: dishError } = await supabase
      .from('dishes')
      .select('section_id, name')
      .in('section_id', sectionIds.slice(i, i + 200))
      .is('deleted_at', null);
    if (dishError) throw new Error(dishError.message);
    dishes.push(...((data ?? []) as typeof dishes));
  }

  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const byRestaurant = new Map<string, Map<string, Set<string>>>();
  for (const dish of dishes) {
    const section = sectionById.get(dish.section_id);
    if (!section?.menu_label) continue; // untagged sections are one menu already
    if (!byRestaurant.has(section.restaurant_id)) byRestaurant.set(section.restaurant_id, new Map());
    const menus = byRestaurant.get(section.restaurant_id)!;
    if (!menus.has(section.menu_label)) menus.set(section.menu_label, new Set());
    menus.get(section.menu_label)!.add(normName(dish.name));
  }

  let exactCount = 0;
  let nearCount = 0;
  let affected = 0;

  for (const [restaurantId, menus] of Array.from(byRestaurant.entries())) {
    const entries = Array.from(menus.entries());
    if (entries.length < 2) continue;
    const lines: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [labelA, setA] = entries[i];
        const [labelB, setB] = entries[j];
        const smaller = Math.min(setA.size, setB.size);
        if (smaller < MIN_DISHES) continue;
        const shared = Array.from(setA).filter((n) => setB.has(n)).length;
        const exact = setA.size === setB.size && shared === setA.size;
        if (exact) {
          exactCount++;
          lines.push(`    EXACT  "${labelA}" == "${labelB}"  (${shared} dishes)`);
        } else if (near && shared / smaller >= NEAR_THRESHOLD) {
          nearCount++;
          lines.push(
            `    near   "${labelA}" ~ "${labelB}"  (${shared}/${smaller}, sizes ${setA.size}/${setB.size})`
          );
        }
      }
    }

    if (lines.length) {
      affected++;
      console.log(`\n  ${nameById.get(restaurantId)} [${cityById.get(restaurantId) ?? '?'}]`);
      for (const line of lines) console.log(line);
    }
  }

  console.log(
    `\n${byRestaurant.size} analysed restaurants with labelled menus; ` +
      `${affected} have duplicate pairs (${exactCount} exact${near ? `, ${nearCount} near` : ''}).`
  );
  if (!near) console.log('Re-run with --near to also list pairs that only mostly overlap.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
