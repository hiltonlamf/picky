// QA preview: exactly which restaurants and menus this branch changes, and how.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping. It replays the
// branch's new rules against the rows already in the database and prints a
// before/after, so the change can be checked by hand before anything is
// re-analysed.
//
//   npx tsx scripts/preview-menu-changes.ts              # every city
//   npx tsx scripts/preview-menu-changes.ts --city dublin
//   npx tsx scripts/preview-menu-changes.ts --visible-only
//
// What it can and cannot predict:
//
//   - Menus dropped as non-food (isNonFoodMenu) — EXACT: the same rule runs
//     against the stored menu label.
//   - Menus flagged as near-duplicates (duplicateMenus) — EXACT: the same
//     comparison, on the stored dishes. Nothing is ever folded or deleted.
//   - Restaurants newly withheld by the per-menu thin tripwire — EXACT.
//   - The phantom "Main Menu" — PREDICTED, not exact. That fix lives in
//     discovery, so confirming it needs a real re-analysis of the site. Any
//     menu still labelled "Main Menu" here is called out as "check on
//     re-analysis".
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { isNonFoodMenu } from '@/lib/menu-discovery';
import { thinMenus, MIN_GUIDE_DISHES } from '@/lib/review-flags';
import type { RawSection, Restaurant } from '@/types';

const cityIndex = process.argv.indexOf('--city');
const city = cityIndex === -1 ? null : process.argv[cityIndex + 1]?.trim().toLowerCase();
const visibleOnly = process.argv.includes('--visible-only');

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let query = supabase.from('restaurants').select('id, name, city').eq('status', 'done');
  if (city) query = query.ilike('city', city);
  const { data: restaurants, error } = await query;
  if (error) throw new Error(error.message);

  const featured = new Set<string>();
  const { data: featuredRows } = await supabase
    .from('featured_restaurants')
    .select('restaurant_id, hidden')
    .eq('hidden', false);
  for (const row of featuredRows ?? []) featured.add(row.restaurant_id as string);

  const ids = (restaurants ?? []).map((r) => r.id as string);
  const sections: Array<{ id: string; restaurant_id: string; menu_label: string | null; name: string }> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await supabase
      .from('menu_sections')
      .select('id, restaurant_id, menu_label, name')
      .in('restaurant_id', ids.slice(i, i + 50));
    sections.push(...((data ?? []) as typeof sections));
  }

  const sectionIds = sections.map((s) => s.id);
  const dishes: Array<{ section_id: string; name: string }> = [];
  for (let i = 0; i < sectionIds.length; i += 200) {
    const { data } = await supabase
      .from('dishes')
      .select('section_id, name')
      .in('section_id', sectionIds.slice(i, i + 200))
      .is('deleted_at', null);
    dishes.push(...((data ?? []) as typeof dishes));
  }

  const dishesBySection = new Map<string, string[]>();
  for (const dish of dishes) {
    if (!dishesBySection.has(dish.section_id)) dishesBySection.set(dish.section_id, []);
    dishesBySection.get(dish.section_id)!.push(dish.name);
  }

  let changed = 0;
  const willBeHidden: string[] = [];

  for (const restaurant of restaurants ?? []) {
    if (visibleOnly && !featured.has(restaurant.id as string)) continue;

    const mine = sections.filter((s) => s.restaurant_id === restaurant.id);
    const before: RawSection[] = mine.map((s) => ({
      name: s.name,
      menuLabel: s.menu_label,
      dishes: (dishesBySection.get(s.id) ?? []).map((name) => ({ name })) as RawSection['dishes'],
    }));
    if (before.length === 0) continue;

    const countsFor = (rows: RawSection[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const label = row.menuLabel ?? '(single menu)';
        counts.set(label, (counts.get(label) ?? 0) + row.dishes.length);
      }
      return counts;
    };

    const beforeCounts = countsFor(before);
    const notes: string[] = [];

    // 1. Non-food menus, dropped at discovery on the next analysis.
    const nonFood = Array.from(beforeCounts.keys()).filter(
      (label) => label !== '(single menu)' && isNonFoodMenu(label)
    );
    const afterNonFood = before.filter((s) => !s.menuLabel || !nonFood.includes(s.menuLabel));
    for (const label of nonFood) {
      notes.push(`  DROP    "${label}" (${beforeCounts.get(label)} dishes) — not a dine-in menu`);
    }

    // 2. Nothing is folded any more — overlapping menus are flagged, not
    //    removed (a lunch menu is often a reduced dinner menu).
    const after = afterNonFood;
    const afterCounts = countsFor(after);
    for (const [label, count] of Array.from(beforeCounts.entries())) {
      if (nonFood.includes(label)) continue;
      if (!afterCounts.has(label)) {
        notes.push(`  FOLD    "${label}" (${count} dishes) — identical to another menu`);
      }
    }
    for (const label of Array.from(afterCounts.keys())) {
      if (!beforeCounts.has(label)) notes.push(`  RENAME  → "${label}"`);
    }
    if (afterCounts.has('(single menu)') && !beforeCounts.has('(single menu)')) {
      notes.push('  MERGE   only one menu left → shown as a single menu (no picker)');
    }

    // 3. Phantom "Main Menu" — predicted, needs a real re-analysis to confirm.
    for (const label of Array.from(afterCounts.keys())) {
      if (/^main menu( \d+)?$/i.test(label)) {
        notes.push(`  CHECK   "${label}" (${afterCounts.get(label)} dishes) — may be the invented name; confirm on re-analysis`);
      }
    }

    // 4. Per-menu thin tripwire, applied to the POST-change shape. Calls the
    //    real rule rather than re-implementing the threshold, so this preview
    //    cannot drift from what the app actually does.
    const thin = thinMenus({ sections: after as unknown as Restaurant['sections'] });
    const total = Array.from(afterCounts.values()).reduce((a, b) => a + b, 0);
    for (const { label, count } of thin) {
      notes.push(`  THIN    "${label}" holds ${count} dish${count === 1 ? '' : 'es'} — restaurant withheld for review`);
    }
    if (thin.length && featured.has(restaurant.id as string)) {
      willBeHidden.push(`${restaurant.name} (${restaurant.city}) — "${thin[0].label}" has ${thin[0].count}`);
    }
    if (total < MIN_GUIDE_DISHES) {
      notes.push(`  NOTE    ${total} dishes total — already below the ${MIN_GUIDE_DISHES}-dish bar`);
    }

    if (notes.length === 0) continue;
    changed++;
    const live = featured.has(restaurant.id as string) ? 'LIVE' : 'not live';
    console.log(`\n${restaurant.name} [${restaurant.city}, ${live}]`);
    console.log(
      `  before: ${Array.from(beforeCounts.entries()).map(([l, c]) => `${l} (${c})`).join(', ')}`
    );
    console.log(
      `  after:  ${Array.from(afterCounts.entries()).map(([l, c]) => `${l} (${c})`).join(', ')}`
    );
    for (const note of notes) console.log(note);
  }

  console.log(`\n${changed} restaurant(s) change.`);
  if (willBeHidden.length) {
    console.log(`\n${willBeHidden.length} currently-live restaurant(s) withheld by the thin-menu tripwire:`);
    for (const line of willBeHidden) console.log(`  - ${line}`);
    console.log('These need a re-analysis (or an admin approval) to come back.');
  }
  console.log('\nNothing above has been written. Changes land when a restaurant is re-analysed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
