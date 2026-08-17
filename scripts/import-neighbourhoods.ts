// Import OSM-derived neighbourhood boundaries from a reviewed GeoJSON export.
//
//   npx tsx scripts/import-neighbourhoods.ts --city dublin --file /path/to/dublin.geojson
//   npx tsx scripts/import-neighbourhoods.ts --city dublin --file /path/to/dublin.geojson --apply
//
// The file must be a FeatureCollection of Polygon/MultiPolygon features with a
// `name` or `name:en` property. Keep its source URL with the guide's data notes.
import './_preload-env';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { pointInGeoJson } from '../lib/location';

type Feature = { type: 'Feature'; properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } | null };
type FeatureCollection = { type: 'FeatureCollection'; features: Feature[] };
const getArg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const city = getArg('--city');
const file = getArg('--file');
const sourceUrl = getArg('--source-url');
const apply = process.argv.includes('--apply');

function validFeature(feature: Feature): { name: string; geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } } | null {
  const name = feature.properties?.['name:en'] ?? feature.properties?.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') return null;
  return { name: name.trim(), geometry: feature.geometry as { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } };
}

async function main() {
  if (!city || !file) throw new Error('Pass both --city <guide slug> and --file <GeoJSON path>.');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as FeatureCollection;
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error('Expected a GeoJSON FeatureCollection.');
  const areas = parsed.features.map(validFeature).filter((value): value is NonNullable<typeof value> => !!value);
  if (!areas.length) throw new Error('No named Polygon or MultiPolygon features found.');

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${areas.length} OSM-derived areas for ${city}`);
  for (const area of areas) console.log(`  ${apply ? 'import' : 'would import'}: ${area.name}`);
  if (!apply) {
    console.log('\nReview names and geometry, then re-run with --apply. No rows were changed.');
    return;
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  for (const area of areas) {
    const { data: existing, error: lookupError } = await supabase
      .from('city_neighbourhoods')
      .select('id')
      .ilike('city', city)
      .ilike('display_name', area.name)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    const row = {
      city,
      display_name: area.name,
      geometry: area.geometry,
      source: 'openstreetmap',
      source_url: sourceUrl,
      source_license: 'Open Data Commons Open Database License (ODbL) v1.0',
      active: true,
      updated_at: new Date().toISOString(),
    };
    const result = existing
      ? await supabase.from('city_neighbourhoods').update(row).eq('id', existing.id)
      : await supabase.from('city_neighbourhoods').insert(row);
    if (result.error) throw new Error(result.error.message);
  }

  // Importing boundaries is the point at which existing coordinates become
  // usable. Reassign them locally in this same one-off operation; no geocoder
  // or external request is involved.
  const { data: boundaries, error: boundaryError } = await supabase
    .from('city_neighbourhoods')
    .select('id, geometry')
    .ilike('city', city)
    .eq('active', true);
  if (boundaryError) throw new Error(boundaryError.message);
  const { data: restaurants, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id, latitude, longitude')
    .ilike('city', city)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);
  if (restaurantError) throw new Error(restaurantError.message);
  let assigned = 0;
  for (const restaurant of restaurants ?? []) {
    const match = (boundaries ?? []).find((area) => pointInGeoJson(
      { latitude: restaurant.latitude as number, longitude: restaurant.longitude as number }, area.geometry
    ));
    if (!match) continue;
    const { error } = await supabase.from('restaurants').update({ neighbourhood_id: match.id }).eq('id', restaurant.id);
    if (error) throw new Error(error.message);
    assigned++;
  }
  console.log(`\nImported ${areas.length} area(s) and assigned ${assigned} existing restaurant coordinate(s) locally.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
