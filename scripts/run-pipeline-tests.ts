/**
 * End-to-end pipeline QA against real restaurant sites.
 *
 *   npx tsx scripts/run-pipeline-tests.ts            # all cases
 *   npx tsx scripts/run-pipeline-tests.ts misters    # filter by substring
 *
 * Calls the library directly (no HTTP / no DB writes):
 *   scrapeRestaurant → discoverMenus → extractAndMerge(all candidates)
 * and asserts the invariants from the plan. Needs ANTHROPIC_API_KEY in
 * .env.local; a reader (Jina keyless by default, or FIRECRAWL_API_KEY) enables
 * JS-rendered sites.
 */
import './_preload-env'; // MUST be first — loads env before lib modules evaluate

import { scrapeRestaurant } from '../lib/scraper';
import { discoverMenus } from '../lib/menu-discovery';
import { extractAndMerge, ExtractContext, looksLikeHeaderItems, MIN_FOOD_ITEMS } from '../lib/menu-extract';
import { countFoodItems } from '../lib/ai';
import { isReaderEnabled } from '../lib/reader';
import type { ClassifiedMenu } from '../types';

type Category = 'text' | 'pdf' | 'image' | 'multilang' | 'js' | 'multi';

interface Case {
  name: string;
  url: string;
  category: Category;
}

const CASES: Case[] = [
  { name: 'Misters', url: 'https://www.misters.ie/', category: 'text' },
  { name: 'Host', url: 'https://hostrestaurant.ie/', category: 'text' },
  { name: 'Good World', url: 'https://www.goodworld.ie', category: 'pdf' },
  { name: 'Dunne & Crescenzi', url: 'https://www.dunneandcrescenzi.com/', category: 'pdf' },
  { name: 'Baan Thai', url: 'https://www.baanthai.ie/', category: 'pdf' },
  { name: 'Notions', url: 'http://notionsdublin.com/', category: 'image' },
  { name: 'Chez Max', url: 'https://chezmax.com/', category: 'multilang' },
  { name: 'Las Tapas de Lola', url: 'https://lastapasdelola.com/', category: 'multilang' },
  { name: 'Forêt', url: 'https://www.foret.ie/menu', category: 'multilang' },
  { name: 'Charming Noodles', url: 'https://charmingnoodles.weebly.com/', category: 'js' },
  { name: 'Shouk', url: 'https://www.shouk.ie/', category: 'js' },
  { name: 'The Vintage Kitchen', url: 'https://thevintagekitchen.ie/', category: 'multi' },
];

const DRINK_RE =
  /\b(wine|beer|lager|ale|stout|porter|cider|cocktail|spirit|whiske?y|gin|vodka|rum|prosecco|champagne|espresso|cappuccino|latte|americano)\b/i;

function dishes(menu: ClassifiedMenu) {
  return menu.sections.flatMap((s) => s.dishes);
}

function dupCount(menu: ClassifiedMenu): number {
  const seen = new Map<string, number>();
  for (const d of dishes(menu)) {
    const k = d.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return Array.from(seen.values()).filter((n) => n > 1).length;
}

let pass = 0;
let fail = 0;
let skip = 0;
const rows: string[] = [];

function check(label: string, cond: boolean): boolean {
  if (cond) { pass++; console.log(`    ✓ ${label}`); }
  else { fail++; console.error(`    ✗ ${label}`); }
  return cond;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function runCase(c: Case): Promise<void> {
  console.log(`\n=== ${c.name} [${c.category}] — ${c.url} ===`);
  try {
    const scrape = await withTimeout(scrapeRestaurant(c.url), 60000, 'scrape');
    const discovery = await withTimeout(discoverMenus(scrape), 60000, 'discover');
    console.log(
      `    candidates: ${discovery.candidates.map((x) => `${x.type}:${x.label}`).join(' | ') || '(none)'}`
    );

    if (c.category === 'js' && !isReaderEnabled()) {
      console.log('    ⚠ skipped extraction assertions (no JS reader configured)');
      skip++;
      rows.push(`${c.name.padEnd(20)} SKIP (no reader)`);
      return;
    }

    if (c.category === 'multi') {
      check(`>=2 distinct candidates (got ${discovery.candidates.length})`, discovery.candidates.length >= 2);
    }

    const ctx: ExtractContext = {
      title: discovery.restaurantTitle,
      inlineText: discovery.inlineText,
      screenshotUrl: discovery.screenshotUrl,
      pdfUrls: scrape.menuPdfUrls,
      imageUrls: scrape.menuImages,
      pageUrl: discovery.finalUrl,
    };

    const { menu } = await withTimeout(extractAndMerge(discovery.candidates, ctx), 120000, 'extract');
    const count = countFoodItems(menu);
    console.log(`    food items: ${count}`);

    check(`>=${MIN_FOOD_ITEMS} food items (got ${count})`, count >= MIN_FOOD_ITEMS);
    check('not header-like', !looksLikeHeaderItems(menu));
    const drinkLeak = dishes(menu).filter((d) => DRINK_RE.test(d.name)).length;
    check(`no drinks leaked (got ${drinkLeak})`, drinkLeak === 0);
    if (c.category === 'multilang') {
      const dups = dupCount(menu);
      check(`no duplicate dish names (got ${dups})`, dups === 0);
    }
    // Note: a PDF site succeeding via HTML/screenshot is still a success — the
    // metric that matters is item count, asserted above.

    rows.push(`${c.name.padEnd(20)} ${count} items`);
  } catch (err) {
    fail++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    ✗ ERROR: ${msg}`);
    rows.push(`${c.name.padEnd(20)} ERROR: ${msg}`);
  }
}

async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const cases = filter ? CASES.filter((c) => c.name.toLowerCase().includes(filter) || c.url.includes(filter)) : CASES;

  console.log(`Reader enabled: ${isReaderEnabled()} | provider auto`);
  console.log(`Running ${cases.length} case(s)...`);

  for (const c of cases) {
    await runCase(c); // sequential — friendlier to reader rate limits
  }

  console.log('\n================ SUMMARY ================');
  for (const r of rows) console.log('  ' + r);
  console.log('----------------------------------------');
  console.log(`  checks: ${pass} passed, ${fail} failed, ${skip} skipped case(s)`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
