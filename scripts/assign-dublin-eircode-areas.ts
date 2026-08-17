// Assign broad Dublin guide areas from already-saved Eircode/address data.
//
//   npx tsx scripts/assign-dublin-eircode-areas.ts
//   npx tsx scripts/assign-dublin-eircode-areas.ts --apply
//
// No external API is called. An area is saved only when the address contains a
// recognised Eircode routing key (or conventional "Dublin 6" district).
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { dublinAreaForAddress } from '../lib/dublin-areas';

const apply = process.argv.includes('--apply');

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name, address')
    .ilike('city', 'dublin')
    .not('address', 'is', null)
    .is('area_label', null)
    .order('created_at');
  if (error) throw new Error(error.message);

  const { data: locations, error: locationsError } = await supabase
    .from('restaurant_locations')
    .select('id, restaurant_id, address, restaurants!inner(name, city)')
    .ilike('restaurants.city', 'dublin')
    .is('area_label', null)
    .order('created_at');
  if (locationsError) throw new Error(locationsError.message);

  let assigned = 0;
  let unmatched = 0;
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Dublin Eircode area assignment (${data?.length ?? 0} legacy address(es), ${locations?.length ?? 0} branch address(es) without an area)`);
  for (const restaurant of data ?? []) {
    const area = dublinAreaForAddress(restaurant.address as string);
    const name = (restaurant.name as string | null) ?? 'Restaurant';
    if (!area) {
      unmatched++;
      console.log(`  no Eircode area: ${name}`);
      continue;
    }
    assigned++;
    console.log(`  ${apply ? 'assigned' : 'would assign'}: ${name} — ${area.label}`);
    if (apply) {
      const { error: updateError } = await supabase
        .from('restaurants')
        .update({ area_code: area.code, area_label: area.label, area_source: 'eircode_prefix' })
        .eq('id', restaurant.id);
      if (updateError) throw new Error(updateError.message);
    }
  }
  for (const location of locations ?? []) {
    const area = dublinAreaForAddress(location.address as string);
    const relation = location.restaurants as unknown as { name?: string | null } | Array<{ name?: string | null }> | null;
    const restaurant = Array.isArray(relation) ? relation[0] : relation;
    const name = restaurant?.name ?? 'Restaurant';
    if (!area) {
      unmatched++;
      console.log(`  no Eircode area (branch): ${name} — ${location.address}`);
      continue;
    }
    assigned++;
    console.log(`  ${apply ? 'assigned' : 'would assign'} branch: ${name} — ${area.label}`);
    if (apply) {
      const { error: updateError } = await supabase
        .from('restaurant_locations')
        .update({ area_code: area.code, area_label: area.label, area_source: 'eircode_prefix' })
        .eq('id', location.id);
      if (updateError) throw new Error(updateError.message);
    }
  }
  console.log(`\n${assigned} area(s) ${apply ? 'assigned' : 'found'}; ${unmatched} address(es) lacked a recognised Dublin postal district.`);
  if (!apply) console.log('Review the output, then re-run with --apply to persist these assignments.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
