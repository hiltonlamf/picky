# Location enrichment

Restaurant address collection is intentionally independent of menu AI work.

- The usual scraper extracts Schema.org JSON-LD or an HTML `address` element from the homepage already fetched for menu discovery. This adds zero Jina, Firecrawl, OpenAI, or Google calls.
- `npx tsx scripts/enrich-locations.ts --city dublin` is an explicit, dry-run-only backfill for one city. Omitting `--city` safely checks every city. In either case it only considers completed restaurants with at least seven live dishes, and saves an address only when the restaurant's own site explicitly identifies its labelled city. It makes ordinary HTTP requests to a restaurant homepage and, only if required, one same-domain Contact page. It never calls a reader service or an LLM. Add `--apply` only after reviewing its output.
- No Google response is persisted. This avoids a Google Cloud account and avoids treating Google place data as permanent guide data.

Neighbourhood assignment is local: a restaurant website may publish coordinates; imported GeoJSON polygons then assign each point with a deterministic point-in-polygon check. No per-restaurant reverse-geocoding call is required.

## Importing a city

Export named `Polygon`/`MultiPolygon` neighbourhood features from an OpenStreetMap-derived source and retain the source URL. Import is dry-run by default:

```sh
npx tsx scripts/import-neighbourhoods.ts --city dublin --file /path/to/dublin-neighbourhoods.geojson
npx tsx scripts/import-neighbourhoods.ts --city dublin --file /path/to/dublin-neighbourhoods.geojson --source-url 'https://www.openstreetmap.org/' --apply
```

The importer records ODbL attribution in the database. It deliberately imports raw names; `city_neighbourhoods.group_name` is reserved for a future guide-specific manual grouping when geography needs a product decision, without overwriting OSM source data.
