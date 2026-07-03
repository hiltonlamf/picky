/**
 * End-to-end pipeline QA against real restaurant sites.
 *
 *   npx tsx scripts/run-pipeline-tests.ts            # core cases (PR gate)
 *   npx tsx scripts/run-pipeline-tests.ts misters    # filter by substring
 *   npx tsx scripts/run-pipeline-tests.ts --smoke    # stable 3-site subset
 *   npx tsx scripts/run-pipeline-tests.ts --extended # core + extended Dublin QA set
 *
 * Cases live in tests/pipeline-cases.json (shared with CI). Calls the library
 * directly (no HTTP / no DB writes):
 *   scrapeRestaurant → discoverMenus → extractAndMerge(all candidates)
 * and asserts the pipeline invariants. Needs ANTHROPIC_API_KEY in .env.local
 * (or the environment); a reader (Jina keyless by default, or
 * FIRECRAWL_API_KEY) enables JS-rendered sites.
 */
import './_preload-env'; // MUST be first — loads env before lib modules evaluate

import { readFileSync } from 'fs';
import path from 'path';
import { scrapeRestaurant } from '../lib/scraper';
import { discoverMenus, DRINK_SOURCE_RE, MAX_PICKER_CANDIDATES } from '../lib/menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext, looksLikeHeaderItems, MIN_FOOD_ITEMS } from '../lib/menu-extract';
import { countFoodItems } from '../lib/ai';
import { isReaderEnabled } from '../lib/reader';
import type { ClassifiedMenu } from '../types';

type Category = 'text' | 'pdf' | 'image' | 'multilang' | 'js' | 'multi';

interface Case {
  name: string;
  url: string;
  category: Category;
  smoke?: boolean;
  /** Extra QA-only sites — run with --extended (or a filter), not on the PR gate. */
  extended?: boolean;
}

const CASES: Case[] = (
  JSON.parse(readFileSync(path.join(__dirname, '..', 'tests', 'pipeline-cases.json'), 'utf8')) as { cases: Case[] }
).cases;

const DRINK_RE =
  /\b(wine|beer|lager|ale|stout|porter|cider|cocktail|spirit|whiske?y|gin|vodka|rum|prosecco|champagne|espresso|cappuccino|latte|americano)\b/i;

function dishes(menu: ClassifiedMenu) {
  return menu.sections.flatMap((s) => s.dishes);
}

/** Duplicate dishes within the same source menu (cross-menu repeats and
 *  same-name-different-price size variants are fine). */
function dupCount(menu: ClassifiedMenu): number {
  const seen = new Map<string, number>();
  for (const s of menu.sections) {
    for (const d of s.dishes) {
      const k = `${s.menuLabel ?? ''}|${d.name.toLowerCase().replace(/[^a-z0-9]/g, '')}|${(d.price ?? '').toLowerCase()}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  return Array.from(seen.values()).filter((n) => n > 1).length;
}

let totalCostUsd = 0;

/** Per-attempt result — lets main() retry a flaky case and keep the better run. */
type CaseResult = {
  pass: number;
  fail: number;
  skip: number;
  row: string;
  /** Full retry ladder ran and found no menu — deterministic, don't re-run it. */
  noMenu?: boolean;
};
let cur: CaseResult = { pass: 0, fail: 0, skip: 0, row: '' };

function check(label: string, cond: boolean): boolean {
  if (cond) { cur.pass++; console.log(`    ✓ ${label}`); }
  else { cur.fail++; console.error(`    ✗ ${label}`); }
  return cond;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function runCase(c: Case): Promise<CaseResult> {
  cur = { pass: 0, fail: 0, skip: 0, row: '' };
  console.log(`\n=== ${c.name} [${c.category}] — ${c.url} ===`);
  try {
    const scrape = await withTimeout(scrapeRestaurant(c.url), 60000, 'scrape');
    const discovery = await withTimeout(discoverMenus(scrape), 90000, 'discover');
    console.log(
      `    candidates: ${discovery.candidates.map((x) => `${x.type}:${x.label}`).join(' | ') || '(none)'}`
    );

    // Candidate-list sanity (the picker bugs): never a "menu images" option,
    // never a drink-only menu, never more than the cap.
    check(
      'no "menu images"-style candidate',
      !discovery.candidates.some((x) => /menu images|page images/i.test(x.label))
    );
    check(
      'no drink-menu candidate (wine list etc.)',
      !discovery.candidates.some((x) => DRINK_SOURCE_RE.test(x.label))
    );
    check(
      `<=${MAX_PICKER_CANDIDATES} candidates (got ${discovery.candidates.length})`,
      discovery.candidates.length <= MAX_PICKER_CANDIDATES
    );
    const imageCandidates = discovery.candidates.filter((x) => x.type === 'image');
    check(
      'image candidate only when it is the sole source',
      imageCandidates.length === 0 || discovery.candidates.length === 1
    );

    if (c.category === 'js' && !isReaderEnabled()) {
      console.log('    ⚠ skipped extraction assertions (no JS reader configured)');
      cur.skip++;
      cur.row = `${c.name.padEnd(20)} SKIP (no reader)`;
      return cur;
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

    // Generous: image-board menus (90+ dishes over 6 photos) on slow CI
    // runners, plus reader 429 backoffs, can exceed 3 minutes legitimately.
    const { menu, usage } = await withTimeout(extractAndMerge(discovery.candidates, ctx), 300000, 'extract');
    totalCostUsd += usage.costUsd;
    const count = countFoodItems(menu);
    console.log(`    food items: ${count} | cost: $${usage.costUsd.toFixed(4)}`);

    check(`>=${MIN_FOOD_ITEMS} food items (got ${count})`, count >= MIN_FOOD_ITEMS);
    check('not header-like', !looksLikeHeaderItems(menu));
    const drinkLeak = dishes(menu).filter((d) => DRINK_RE.test(d.name)).length;
    check(`no drinks leaked (got ${drinkLeak})`, drinkLeak === 0);
    const dups = dupCount(menu);
    check(`no duplicate dish names within a menu (got ${dups})`, dups === 0);
    if (c.category === 'multi') {
      const labels = new Set(menu.sections.map((s) => s.menuLabel).filter(Boolean));
      check(`sections grouped by menu label (got ${labels.size})`, labels.size >= 2);
    }
    // Note: a PDF site succeeding via HTML/screenshot is still a success — the
    // metric that matters is item count, asserted above.

    cur.row = `${c.name.padEnd(20)} ${count} items  $${usage.costUsd.toFixed(4)}`;
  } catch (err) {
    cur.fail++;
    const msg = err instanceof Error ? err.message : String(err);
    // Failed retry ladders are the most expensive path — count their spend
    // too, or the cost total silently undercounts the worst sites.
    if (err instanceof ExtractionError && err.usage) {
      totalCostUsd += err.usage.costUsd;
      cur.noMenu = true; // full ladder already ran — a re-run won't change this
      console.error(`    ✗ ERROR: ${msg}`);
      console.error(`      (failed attempts still cost $${err.usage.costUsd.toFixed(4)})`);
      cur.row = `${c.name.padEnd(20)} ERROR ($${err.usage.costUsd.toFixed(4)} spent): ${msg}`;
    } else {
      console.error(`    ✗ ERROR: ${msg}`);
      cur.row = `${c.name.padEnd(20)} ERROR: ${msg}`;
    }
  }
  return cur;
}

async function main() {
  const arg = process.argv[2]?.toLowerCase();
  const smoke = arg === '--smoke';
  const extended = arg === '--extended';
  const filter = smoke || extended ? undefined : arg;
  const cases = smoke
    ? CASES.filter((c) => c.smoke)
    : extended
      ? CASES
      : filter
        ? CASES.filter((c) => c.name.toLowerCase().includes(filter) || c.url.includes(filter))
        : CASES.filter((c) => !c.extended);

  console.log(`Reader enabled: ${isReaderEnabled()} | provider auto${smoke ? ' | SMOKE subset' : extended ? ' | EXTENDED set' : ''}`);
  console.log(`Running ${cases.length} case(s)...`);

  let pass = 0;
  let fail = 0;
  let skip = 0;
  const rows: string[] = [];
  const flaky: string[] = [];

  for (const c of cases) {
    let result = await runCase(c); // sequential — friendlier to reader rate limits

    // Live sites + keyless reader tiers are flaky: one retry after a cooldown
    // absorbs transient 429s/site hiccups so only PERSISTENT failures gate a
    // merge. Real spend on both attempts is still counted in the cost total.
    // EXCEPTION: "no menu found" after the full retry ladder is deterministic
    // and the priciest failure there is — re-running it doubles the bill for
    // the same answer, so don't.
    if (result.fail > 0 && !result.noMenu) {
      console.log(`    ↻ retrying ${c.name} after a 60s cooldown (transient site/reader flakiness?)...`);
      await new Promise((r) => setTimeout(r, 60000));
      const second = await runCase(c);
      if (second.fail < result.fail) {
        result = second;
        flaky.push(c.name);
      }
    }

    pass += result.pass;
    fail += result.fail;
    skip += result.skip;
    rows.push(result.row);
  }

  console.log('\n================ SUMMARY ================');
  for (const r of rows) console.log('  ' + r);
  console.log('----------------------------------------');
  if (flaky.length > 0) console.log(`  passed on retry (flaky): ${flaky.join(', ')}`);
  console.log(`  checks: ${pass} passed, ${fail} failed, ${skip} skipped case(s)`);
  console.log(`  total LLM cost: $${totalCostUsd.toFixed(4)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
