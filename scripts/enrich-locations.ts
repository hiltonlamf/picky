// Populate first-party addresses for one city without spending reader/LLM/API quota.
//
//   npx tsx scripts/enrich-locations.ts --city dublin
//   npx tsx scripts/enrich-locations.ts --city dublin --apply
//
// Dry-run is intentional. Each candidate gets at most two ordinary HTTP
// requests: its homepage and, only when needed, one same-domain Contact page.
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { findLocationOnWebsite, isCandidateInCity } from '../lib/location';
import { saveRestaurantLocation } from '../lib/db';

const cityIndex = process.argv.indexOf('--city');
const city = cityIndex === -1 ? 'dublin' : process.argv[cityIndex + 1];
const apply = process.argv.includes('--apply');

if (!city) throw new Error('Pass --city <guide slug>.');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name, url, canonical_url')
    .ilike('city', city)
    .is('address', null)
    .order('created_at');
  if (error) throw new Error(error.message);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — first-party location enrichment for ${city} (${data?.length ?? 0} restaurants)`);
  let found = 0;
  let rejected = 0;
  let failed = 0;
  for (const restaurant of data ?? []) {
    const url = (restaurant.canonical_url as string | null) ?? (restaurant.url as string);
    const name = (restaurant.name as string | null) ?? url;
    try {
      const candidate = await findLocationOnWebsite(url);
      if (!candidate) {
        console.log(`  no location: ${name}`);
      } else if (!candidate.address || !isCandidateInCity(candidate, city)) {
        rejected++;
        console.log(`  rejected outside ${city}: ${name} — ${candidate.address || 'coordinates only'}`);
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
  console.log(`\n${found} location candidate(s) ${apply ? 'saved' : 'found'}; ${rejected} candidate(s) rejected outside ${city}; ${failed} restaurant(s) skipped; no paid APIs were called.`);
  if (!apply) console.log('Review the output, then re-run with --apply to persist these values.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
