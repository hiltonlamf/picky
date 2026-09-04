/**
 * End-to-end pipeline QA against real restaurant sites.
 *
 *   npx tsx scripts/run-pipeline-tests.ts            # core cases (PR gate)
 *   npx tsx scripts/run-pipeline-tests.ts misters    # filter by substring
 *   npx tsx scripts/run-pipeline-tests.ts tofu,lina  # or several, comma-separated
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
import { discoverMenus, DRINK_SOURCE_RE, isNonFoodMenu, MAX_PICKER_CANDIDATES } from '../lib/menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext, looksLikeHeaderItems, MIN_FOOD_ITEMS } from '../lib/menu-extract';
import { countFoodItems } from '../lib/ai';
import { isReaderEnabled } from '../lib/reader';
import { withSpendContext } from '../lib/ai-spend';
import type { ClassifiedMenu } from '../types';

type Category = 'text' | 'pdf' | 'image' | 'multilang' | 'js' | 'multi';

/**
 * Optional live timing probe. Enable with PIPELINE_TIMING=1 when investigating
 * latency; ordinary QA output and behavior stay unchanged. This wraps the
 * process fetch rather than individual providers, so the report proves which
 * services actually ran (including Jina followed by Firecrawl) and also counts
 * direct site/PDF/image requests and spend-ledger writes.
 */
type NetworkKind = 'jina' | 'firecrawl' | 'anthropic' | 'supabase' | 'site';
type NetworkTiming = { kind: NetworkKind; durationMs: number; ok: boolean };
const TIMING_ENABLED = process.env.PIPELINE_TIMING === '1';
const networkTimings: NetworkTiming[] = [];

function networkKind(input: string | URL | Request): NetworkKind {
  let hostname = '';
  try {
    const raw = input instanceof Request ? input.url : String(input);
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {}
  if (hostname === 'r.jina.ai') return 'jina';
  if (hostname === 'api.firecrawl.dev') return 'firecrawl';
  if (hostname === 'api.anthropic.com') return 'anthropic';
  if (hostname.endsWith('.supabase.co')) return 'supabase';
  return 'site';
}

if (TIMING_ENABLED) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const startedAt = performance.now();
    const kind = networkKind(input);
    try {
      const response = await originalFetch(input, init);
      networkTimings.push({ kind, durationMs: performance.now() - startedAt, ok: response.ok });
      return response;
    } catch (error) {
      networkTimings.push({ kind, durationMs: performance.now() - startedAt, ok: false });
      throw error;
    }
  };
}

function formatNetworkTiming(startIndex: number): string {
  const rows = networkTimings.slice(startIndex);
  const kinds: NetworkKind[] = ['jina', 'firecrawl', 'anthropic', 'supabase', 'site'];
  return kinds
    .map((kind) => {
      const matching = rows.filter((row) => row.kind === kind);
      if (!matching.length) return null;
      const totalMs = matching.reduce((sum, row) => sum + row.durationMs, 0);
      const failed = matching.filter((row) => !row.ok).length;
      return `${kind} ${matching.length} calls/${(totalMs / 1000).toFixed(1)}s${failed ? `/${failed} failed` : ''}`;
    })
    .filter(Boolean)
    .join(' | ');
}

interface Case {
  name: string;
  url: string;
  category: Category;
  smoke?: boolean;
  /** Extra QA-only sites — run with --extended (or a filter), not on the PR gate. */
  extended?: boolean;
  /**
   * The menu is knowably unreadable to us (e.g. a view-only Google Drive file),
   * so "reported as blocked" IS the pass condition. Turns a permanently-red
   * case into a regression guard for the blocked-reporting path — and stops it
   * buying a paid retry on every run. If the site ever unblocks, this fails
   * loudly with "expected blocked, got a menu", which is the signal we want.
   */
  expectBlocked?: boolean;
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

/**
 * Infrastructure flakiness — the only class of failure a paid re-run can fix.
 * An assertion failure (item count, duplicates, drink leak) is deterministic
 * given the same page: re-running it just pays twice for the same red.
 */
const TRANSIENT_RE = /timed out after|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|\b(429|503|502|504)\b/i;

/** Per-attempt result — lets main() retry a flaky case and keep the better run. */
type CaseResult = {
  pass: number;
  fail: number;
  skip: number;
  row: string;
  /** Full retry ladder ran and found no menu — deterministic, don't re-run it. */
  noMenu?: boolean;
  /** Failure looked like infrastructure flakiness, so a re-run may differ. */
  transient?: boolean;
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

/**
 * QA spend is real spend, and it was invisible.
 *
 * Every call here goes through callClaude, which writes an ai_usage_log row —
 * but only if Supabase is configured. In CI it wasn't, so a whole class of
 * genuine spend (this PR alone: ~$1.25 across nine runs; CLAUDE.md records a
 * two-day QA session that burned ~$12) never reached the ledger we make budget
 * decisions from. Wrapping each case attributes its rows to the site under
 * test, so a run can be read back per restaurant rather than as a lump.
 */
function runCase(c: Case): Promise<CaseResult> {
  return withSpendContext({ url: c.url, restaurantName: `QA: ${c.name}`, source: 'qa' }, () => runCaseInner(c));
}

async function runCaseInner(c: Case): Promise<CaseResult> {
  cur = { pass: 0, fail: 0, skip: 0, row: '' };
  console.log(`\n=== ${c.name} [${c.category}] — ${c.url} ===`);
  const caseStartedAt = performance.now();
  const networkStartIndex = networkTimings.length;
  let scrapeMs = 0;
  let discoverMs = 0;
  let extractMs = 0;
  // Declared outside the try so the catch paths below can include it too: a
  // case that fails during extraction still paid for discovery.
  let discoveryCost = 0;
  try {
    const scrapeStartedAt = performance.now();
    const scrape = await withTimeout(scrapeRestaurant(c.url), 60000, 'scrape');
    scrapeMs = performance.now() - scrapeStartedAt;
    const discoverStartedAt = performance.now();
    const discovery = await withTimeout(discoverMenus(scrape), 90000, 'discover');
    discoverMs = performance.now() - discoverStartedAt;
    // Discovery's candidate-labelling call is billed. Counting only extraction
    // is why this script printed $0.3601 for run #49 while ai_usage_log — the
    // authoritative ledger — recorded $0.3692 for the same seven cases.
    discoveryCost = discovery.usage?.costUsd ?? 0;
    totalCostUsd += discoveryCost;
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
      'no non-dining candidate (bookings/preferences/etc.)',
      !discovery.candidates.some((x) => isNonFoodMenu(x.label))
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
    const extractStartedAt = performance.now();
    const { menu, usage } = await withTimeout(extractAndMerge(discovery.candidates, ctx), 300000, 'extract');
    extractMs = performance.now() - extractStartedAt;
    totalCostUsd += usage.costUsd;
    const count = countFoodItems(menu);
    console.log(`    food items: ${count} | cost: $${(usage.costUsd + discoveryCost).toFixed(4)}`);

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

    cur.row = `${c.name.padEnd(20)} ${count} items  $${(usage.costUsd + discoveryCost).toFixed(4)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // A site we're documented as unable to read (Waterkant's Drive file is
    // view-only) is a PASS when it reports itself as blocked: that's the
    // blocked-reporting path working, which is the behaviour worth guarding.
    // Previously it was a permanent red that ALSO bought a paid re-run.
    if (c.expectBlocked && err instanceof ExtractionError && err.blocked) {
      if (err.usage) totalCostUsd += err.usage.costUsd;
      cur.noMenu = true;
      check('reported as blocked, not as "no menu"', true);
      cur.row = `${c.name.padEnd(20)} blocked as expected`;
      return cur;
    }

    cur.fail++;
    // `noMenu` must NOT depend on `err.usage`. A blocked site throws before any
    // billed call, so it has no usage — and the old `&& err.usage` guard let it
    // fall through to the retry below, buying a second full scrape+ladder for
    // the identical deterministic answer. Deciding "don't re-run" and "book the
    // spend" are separate questions.
    if (err instanceof ExtractionError) {
      cur.noMenu = true; // full ladder already ran — a re-run won't change this
      if (err.usage) {
        totalCostUsd += err.usage.costUsd;
        console.error(`    ✗ ERROR: ${msg}`);
        console.error(`      (failed attempts still cost $${err.usage.costUsd.toFixed(4)})`);
        cur.row = `${c.name.padEnd(20)} ERROR ($${(err.usage.costUsd + discoveryCost).toFixed(4)} spent): ${msg}`;
      } else {
        console.error(`    ✗ ERROR: ${msg}`);
        cur.row = `${c.name.padEnd(20)} ERROR (no billed calls): ${msg}`;
      }
    } else {
      console.error(`    ✗ ERROR: ${msg}`);
      cur.row = `${c.name.padEnd(20)} ERROR: ${msg}`;
      // Only infrastructure flakiness is worth a paid second attempt.
      cur.transient = TRANSIENT_RE.test(msg);
    }
  }
  if (TIMING_ENABLED) {
    console.log(
      `    timing: total ${((performance.now() - caseStartedAt) / 1000).toFixed(1)}s | ` +
      `scrape ${(scrapeMs / 1000).toFixed(1)}s | discover ${(discoverMs / 1000).toFixed(1)}s | ` +
      `extract ${(extractMs / 1000).toFixed(1)}s`
    );
    console.log(`    network: ${formatNetworkTiming(networkStartIndex) || 'no fetch calls recorded'}`);
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
        ? // Comma-separated substrings: "tofu,lina,kas" targets exactly those
          // sites. Re-verifying one fix shouldn't mean paying for 15 cases.
          CASES.filter((c) =>
            filter
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
              .some((t) => c.name.toLowerCase().includes(t) || c.url.toLowerCase().includes(t))
          )
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

    // Live sites + keyless reader tiers are flaky, so one cooldown retry
    // absorbs transient 429s/site hiccups and only PERSISTENT failures gate a
    // merge. But a retry is a SECOND full paid run of the case, so it must be
    // reserved for failures a re-run could actually change:
    //  - `noMenu`: the full ladder already ran (or the site refused us). Same
    //    answer, doubled bill.
    //  - assertion failures (item count, duplicates, drink leak): deterministic
    //    given the same page. Re-running pays twice for the same red.
    // Only infrastructure errors — timeouts, resets, 429/503 — get a retry.
    if (result.fail > 0 && !result.noMenu && result.transient) {
      console.log(`    ↻ retrying ${c.name} after a 60s cooldown (transient site/reader flakiness)...`);
      await new Promise((r) => setTimeout(r, 60000));
      const second = await runCase(c);
      if (second.fail < result.fail) {
        result = second;
        flaky.push(c.name);
      }
    } else if (result.fail > 0) {
      console.log(`    (not retried — deterministic failure, a re-run would cost the same and fail the same)`);
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
