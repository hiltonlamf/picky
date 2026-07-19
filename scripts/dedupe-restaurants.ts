// One-off maintenance: backfill restaurants.dedup_key, rewrite each dedicated-
// domain restaurant's url to its clean root form, and merge duplicate rows that
// were created before the dedup fix (e.g. dohertysbar.ie/menu vs dohertysbar.ie).
//
// Safe by default: prints what it WOULD do. Pass --apply to write changes.
// Run after adding the dedup_key column; the unique index is created afterwards.
//
//   npx tsx scripts/dedupe-restaurants.ts            # dry run
//   npx tsx scripts/dedupe-restaurants.ts --apply    # execute
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { restaurantDedupKey, canonicalRestaurantUrl } from '../lib/db';

const APPLY = process.argv.includes('--apply');

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

type Row = { id: string; url: string; canonical_url: string | null; status: string; last_scraped_at: string | null };

async function liveDishCount(supabase: ReturnType<typeof db>, restaurantId: string): Promise<number> {
  const { count } = await supabase
    .from('dishes')
    .select('*', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .is('deleted_at', null);
  return count ?? 0;
}

// The row we KEEP from a duplicate group: prefer a completed analysis, then the
// one with the most real dishes, then the most recently scraped.
function pickSurvivor(rows: Array<Row & { dishes: number }>): Row & { dishes: number } {
  return [...rows].sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? -1 : 1;
    if (a.dishes !== b.dishes) return b.dishes - a.dishes;
    return (b.last_scraped_at ?? '').localeCompare(a.last_scraped_at ?? '');
  })[0];
}

async function main() {
  const supabase = db();
  console.log(APPLY ? '⚙️  APPLY mode — writing changes\n' : '🔎 DRY RUN — no changes written (pass --apply to execute)\n');

  const { data, error } = await supabase
    .from('restaurants')
    .select('id, url, canonical_url, status, last_scraped_at');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];

  // Group by dedup key.
  const groups = new Map<string, Array<Row & { dishes: number }>>();
  for (const r of rows) {
    const key = restaurantDedupKey(r.url);
    const dishes = await liveDishCount(supabase, r.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ ...r, dishes });
  }

  let merged = 0;
  let deleted = 0;
  let rewritten = 0;

  for (const [key, group] of Array.from(groups.entries())) {
    const survivor = pickSurvivor(group);
    const losers = group.filter((g) => g.id !== survivor.id);

    if (losers.length > 0) {
      merged++;
      console.log(`DUPLICATE key="${key}" → keep ${survivor.id} (${survivor.url}, ${survivor.status}, ${survivor.dishes} dishes)`);
      for (const l of losers) {
        console.log(`   drop ${l.id} (${l.url}, ${l.status}, ${l.dishes} dishes)`);
      }

      // Preserve guide membership: ensure the survivor is featured in every city
      // any group member was featured in, before the losers (and their featured
      // rows) are cascade-deleted.
      const loserIds = losers.map((l) => l.id);
      const { data: feats } = await supabase
        .from('featured_restaurants')
        .select('city, display_order')
        .in('restaurant_id', [survivor.id, ...loserIds]);
      const cities = Array.from(new Set((feats ?? []).map((f) => f.city as string)));
      for (const city of cities) {
        if (APPLY) {
          const order = Math.min(...(feats ?? []).filter((f) => f.city === city).map((f) => f.display_order as number));
          await supabase
            .from('featured_restaurants')
            .upsert({ restaurant_id: survivor.id, city, display_order: order }, { onConflict: 'restaurant_id,city' });
        }
        console.log(`   → survivor featured in "${city}"`);
      }

      if (APPLY) {
        const { error: delErr } = await supabase.from('restaurants').delete().in('id', loserIds);
        if (delErr) throw new Error(`delete failed for key ${key}: ${delErr.message}`);
      }
      deleted += losers.length;
    }

    // Backfill dedup_key + rewrite the survivor's url to the clean root form.
    const cleanUrl = canonicalRestaurantUrl(survivor.url);
    const needsRewrite = cleanUrl !== survivor.url;
    if (needsRewrite) {
      rewritten++;
      console.log(`REWRITE ${survivor.id}: "${survivor.url}" → "${cleanUrl}"`);
    }
    if (APPLY) {
      await supabase.from('restaurants').update({ url: cleanUrl, dedup_key: key }).eq('id', survivor.id);
    }
  }

  console.log(`\nSummary: ${groups.size} unique restaurants, ${merged} duplicate group(s), ${deleted} row(s) ${APPLY ? 'deleted' : 'to delete'}, ${rewritten} url(s) ${APPLY ? 'rewritten' : 'to rewrite'}.`);
  if (!APPLY) console.log('Re-run with --apply to execute.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
