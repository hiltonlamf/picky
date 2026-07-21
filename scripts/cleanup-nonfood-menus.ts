// Remove non-food "menus" (allergen sheets, catering/collection/delivery,
// kids' menus, gift vouchers, ...) that earlier analyses captured as separate
// menus. Uses the SAME NON_FOOD_MENU_RE the discovery pipeline now uses, so this
// is the retroactive twin of the going-forward fix. Reuses removeMenu (deletes
// dishes then sections — never orphans dishes).
//
//   npx tsx scripts/cleanup-nonfood-menus.ts            # dry run
//   npx tsx scripts/cleanup-nonfood-menus.ts --apply    # execute
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { isNonFoodMenu } from '../lib/menu-discovery';
import { removeMenu } from '../lib/db';

const APPLY = process.argv.includes('--apply');

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function main() {
  const supabase = db();
  console.log(`${APPLY ? '⚙️  APPLY' : '🔎 DRY RUN'} — removing non-food menus\n`);

  const { data: rests } = await supabase.from('restaurants').select('id, name, url, canonical_url, city');
  const restaurants = (rests ?? []) as Array<{ id: string; name: string | null; url: string; canonical_url: string | null; city: string | null }>;

  let removedGroups = 0;
  let removedDishes = 0;

  for (const r of restaurants) {
    const { data: secs } = await supabase.from('menu_sections').select('menu_label').eq('restaurant_id', r.id);
    const labels = Array.from(new Set(((secs ?? []) as Array<{ menu_label: string | null }>).map((s) => s.menu_label)));
    const bad = labels.filter((l): l is string => !!l && isNonFoodMenu(l));
    for (const label of bad) {
      console.log(`  ${r.name ?? r.url} → drop "${label}"`);
      if (APPLY) {
        const res = await removeMenu({
          restaurantId: r.id,
          restaurantUrl: r.canonical_url ?? r.url,
          restaurantName: r.name,
          city: r.city,
          menuLabel: label,
        });
        removedDishes += res.removedDishCount;
      }
      removedGroups++;
    }
  }

  console.log(`\n${removedGroups} non-food menu group(s) ${APPLY ? `removed (${removedDishes} dishes)` : 'to remove'}.`);
  if (!APPLY) console.log('Re-run with --apply to execute.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
