/**
 * Record a ScrapeResult fixture for deterministic unit tests.
 *
 *   npx tsx scripts/record-fixture.ts <url> <fixture-name>
 *   e.g. npx tsx scripts/record-fixture.ts https://www.misters.ie text-menu
 *
 * Network only (reader + cheerio) — no LLM calls, no DB writes. Fixtures are
 * committed snapshots; re-record when a site changes shape.
 */
import './_preload-env'; // MUST be first — loads env before lib modules evaluate

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { scrapeRestaurant } from '../lib/scraper';

async function main() {
  const [url, name] = process.argv.slice(2);
  if (!url || !name) {
    console.error('Usage: npx tsx scripts/record-fixture.ts <url> <fixture-name>');
    process.exit(1);
  }

  console.log(`Scraping ${url} ...`);
  const scrape = await scrapeRestaurant(url);

  const fixture = {
    recordedAt: new Date().toISOString(),
    sourceUrl: url,
    scrape,
  };

  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');

  console.log(`Wrote ${file}`);
  console.log(`  text: ${scrape.menuText.length} chars | pdfs: ${scrape.menuPdfUrls?.length ?? 0} | images: ${scrape.menuImages?.length ?? 0} | menuLinks: ${scrape.menuLinks?.length ?? 0} | navLinks: ${scrape.navLinks?.length ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
