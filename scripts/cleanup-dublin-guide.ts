// Un-feature the broken auto-seeded guide entries: any restaurant in a city
// guide that errored or came back with too few dishes (< the public bar). These
// were bootstrapped automatically, not hand-curated, so removing them just makes
// the admin guide list match what the public actually sees. Odd-but-approvable
// restaurants (>= the dish bar, e.g. a tasting menu read as one dish) are LEFT
// featured on purpose, so they stay in the admin "needs review" queue.
//
//   npx tsx scripts/cleanup-dublin-guide.ts            # dry run
//   npx tsx scripts/cleanup-dublin-guide.ts --apply    # execute
//   npx tsx scripts/cleanup-dublin-guide.ts --city dublin --apply
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { MIN_GUIDE_DISHES } from '../lib/review-flags';

const APPLY = process.argv.includes('--apply');
const cityArg = process.argv.indexOf('--city');
const CITY = cityArg !== -1 ? process.argv[cityArg + 1] : 'dublin';

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function main() {
  const supabase = db();
  console.log(
    `${APPLY ? '⚙️  APPLY' : '🔎 DRY RUN'} — un-feature broken/thin restaurants in the "${CITY}" guide\n`
  );

  const { data: feats } = await supabase.from('featured_restaurants').select('restaurant_id').eq('city', CITY);
  const ids = (feats ?? []).map((f) => f.restaurant_id as string);
  if (ids.length === 0) {
    console.log('No featured restaurants for this city.');
    return;
  }

  const { data: rests } = await supabase.from('restaurants').select('id, name, url, status').in('id', ids);
  const { data: dishRows } = await supabase.from('dishes').select('restaurant_id').is('deleted_at', null).in('restaurant_id', ids);
  const dishCount = new Map<string, number>();
  for (const d of dishRows ?? []) {
    const rid = d.restaurant_id as string;
    dishCount.set(rid, (dishCount.get(rid) ?? 0) + 1);
  }

  const toRemove: Array<{ id: string; name: string; reason: string }> = [];
  for (const r of rests ?? []) {
    const id = r.id as string;
    const n = dishCount.get(id) ?? 0;
    const status = r.status as string;
    let reason = '';
    if (status !== 'done') reason = `status ${status}`;
    else if (n < MIN_GUIDE_DISHES) reason = `only ${n} dish${n === 1 ? '' : 'es'} (< ${MIN_GUIDE_DISHES})`;
    if (reason) toRemove.push({ id, name: (r.name as string | null) ?? (r.url as string), reason });
  }

  if (toRemove.length === 0) {
    console.log('Nothing to un-feature — every featured restaurant meets the bar. 🎉');
    return;
  }
  for (const t of toRemove) console.log(`  un-feature ${t.name} (${t.id}) — ${t.reason}`);

  if (APPLY) {
    const { error } = await supabase
      .from('featured_restaurants')
      .delete()
      .eq('city', CITY)
      .in('restaurant_id', toRemove.map((t) => t.id));
    if (error) throw new Error(error.message);
  }
  console.log(`\n${toRemove.length} restaurant(s) ${APPLY ? 'un-featured' : 'to un-feature'}.`);
  if (!APPLY) console.log('Re-run with --apply to execute.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
