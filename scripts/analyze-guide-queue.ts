// Analyse a city guide's outstanding restaurants — the SERVER-SIDE batch.
//
// This exists because the guide batch used to run inside the admin's browser
// tab (app/admin/guides/batchAnalyze.ts). Close the tab and the loop stopped:
// every remaining restaurant stayed `pending` and whichever one was mid-flight
// stayed `processing` forever, with nothing anywhere that would ever pick them
// up. The founder hit exactly that — 40 Cork and 40 Limerick restaurants added,
// most of them still "queued" hours later.
//
// It cannot run in a Vercel function: the Hobby plan kills any function at 60
// seconds and a single restaurant takes 30-60s, so a 40-restaurant batch needs
// ~30 minutes. It runs on a GitHub Actions runner instead — see
// .github/workflows/analyze-queue.yml, the same pattern pipeline.yml already
// uses for long, paid, on-demand work.
//
//   npx tsx scripts/analyze-guide-queue.ts --city=cork                 # dry run, $0
//   npx tsx scripts/analyze-guide-queue.ts --city=cork --yes           # spends money
//   npx tsx scripts/analyze-guide-queue.ts --city=cork --yes --limit=5
//   npx tsx scripts/analyze-guide-queue.ts --city=cork --yes --mode=failed
//
// SPENDS REAL AI MONEY, so it is --yes-gated like scripts/reanalyze.ts. A dry
// run costs nothing and prints exactly what a real run would do.
import './_preload-env';
import { appendFileSync } from 'node:fs';
import { aiSpendSince, listGuideQueue } from '../lib/db';
import { selectQueue, queueSummary, type QueueMode, type QueueRow } from '../lib/guide-queue';
import { reanalyseRestaurant, type ReanalyseResult } from '../lib/reanalyse';
import { checkDailySpend } from '../lib/spend-guard';

const APPLY = process.argv.includes('--yes');

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3) || undefined;
}

const CITY = (arg('city') ?? '').trim().toLowerCase();
const MODE: QueueMode = arg('mode') === 'failed' ? 'failed' : 'queued';
const LIMIT = arg('limit') ? Number(arg('limit')) : undefined;

/**
 * Stop cleanly rather than being killed mid-restaurant.
 *
 * A runner that hits its hard `timeout-minutes` dies wherever it happens to be,
 * leaving that restaurant `processing` — recoverable (the next pass reclaims it
 * after the staleness window) but it wastes the analysis that was in flight.
 * Finishing the current restaurant and exiting tidily is strictly better.
 */
const BUDGET_MINUTES = Number(arg('budget-minutes') ?? '100');

/**
 * Small pause between restaurants. When a site analyses successfully the work
 * already takes 30-60s, so this adds nothing meaningful; its real job is to stop
 * a run of FAST failures (dead sites) from firing dozens of page-reader calls
 * per minute and tripping the reader's rate limit — the exact failure that made
 * a whole Amsterdam batch come back empty.
 */
const INTER_RESTAURANT_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Give up after this many failures in a row.
 *
 * A dead page-reader, an expired API key or a switched-off Anthropic account
 * makes EVERY restaurant fail — at full price, because a hopeless site still
 * walks its whole retry ladder (10-20+ billed calls). Grinding through 40 of
 * those is the shape of a surprise bill, and it cannot succeed. Five in a row
 * is well past bad luck: real guides contain the odd menuless restaurant, but
 * not five consecutively.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Hands `remaining` back to the workflow so it can continue an unfinished pass. */
function emitOutputs(values: Record<string, string | number>): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  try {
    appendFileSync(out, `${body}\n`);
  } catch {
    // Local runs have no $GITHUB_OUTPUT; the console output above is the record.
  }
}

function line(row: QueueRow): string {
  return `${row.name ?? row.url.replace(/^https?:\/\//, '')}`;
}

async function main() {
  if (!CITY) {
    console.error('Usage: npx tsx scripts/analyze-guide-queue.ts --city=<slug> [--yes] [--mode=queued|failed] [--limit=N]');
    process.exit(1);
  }

  const all = await listGuideQueue(CITY);
  if (!all.length) {
    console.log(`\nThe "${CITY}" guide has no restaurants curated into it. Nothing to do.`);
    emitOutputs({ remaining: 0, analysed: 0, failed: 0 });
    return;
  }

  const before = queueSummary(all);
  const queue = selectQueue(all, { mode: MODE, limit: LIMIT });

  console.log(`\n${APPLY ? '⚙️  APPLY' : '🔎 DRY'} — ${CITY} guide, mode=${MODE}\n`);
  console.log(
    `  curated: ${before.total} · analysed: ${before.analysed} · waiting: ${before.waiting} · ` +
      `running now: ${before.running} · failed: ${before.failed}`
  );
  // A pass that reclaims rows should say so — it is the answer to "why has this
  // been 'analyzing' for six hours?".
  const reclaimed = queue.filter((r) => r.status === 'processing');
  if (reclaimed.length) {
    console.log(
      `  reclaiming ${reclaimed.length} restaurant(s) left mid-analysis by an interrupted run:` +
        `\n${reclaimed.map((r) => `         · ${line(r)}`).join('\n')}`
    );
  }
  console.log(`\n  this pass: ${queue.length} restaurant(s)\n`);

  if (!queue.length) {
    console.log(
      MODE === 'failed'
        ? '  Nothing has failed. Nothing to retry.'
        : '  Nothing is waiting. The guide is fully analysed (or a run is working it right now).'
    );
    emitOutputs({ remaining: 0, analysed: 0, failed: 0 });
    return;
  }

  if (!APPLY) {
    for (const row of queue) console.log(`  would analyse ${line(row)}  (${row.url})`);
    console.log(
      `\n  Re-run with --yes to execute. Rough cost: ~$${(queue.length * 0.05).toFixed(2)} if they ` +
        `succeed — FAILURES COST MORE (every retry rung is a full-price call).`
    );
    emitOutputs({ remaining: queue.length, analysed: 0, failed: 0 });
    return;
  }

  const runStart = new Date();
  const deadline = runStart.getTime() + BUDGET_MINUTES * 60_000;

  let analysed = 0;
  let failed = 0;
  let attributedCost = 0;
  let consecutiveFailures = 0;
  let stopReason: string | null = null;
  let processed = 0;

  for (const row of queue) {
    if (Date.now() >= deadline) {
      stopReason = `time budget of ${BUDGET_MINUTES} min reached`;
      break;
    }

    // The global $/day backstop. No script checked this before, so a
    // script-driven batch bypassed the cap that guards the API routes entirely.
    const spend = await checkDailySpend();
    if (!spend.allowed) {
      stopReason = `daily spend cap reached ($${spend.spentUsd.toFixed(2)} of $${spend.capUsd.toFixed(2)})`;
      break;
    }

    if (processed > 0) await sleep(INTER_RESTAURANT_DELAY_MS);
    processed++;
    process.stdout.write(`  [${processed}/${queue.length}] ${line(row)} … `);

    let result: ReanalyseResult;
    try {
      result = await reanalyseRestaurant(row.id);
    } catch (err) {
      // reanalyseRestaurant records its own outcome on the row; this catch is
      // for the unexpected (a network fault mid-write). Never let one
      // restaurant take the whole batch down.
      result = { outcome: 'error', message: err instanceof Error ? err.message : 'failed' };
    }

    if (typeof result.costUsd === 'number') attributedCost += result.costUsd;

    if (result.outcome === 'done') {
      analysed++;
      consecutiveFailures = 0;
      // Dish count is the quality signal that matters: a "success" with 2 dishes
      // is a mis-read menu, not a working restaurant.
      const thin = (result.dishCount ?? 0) < 7 ? '  ⚠ THIN' : '';
      console.log(`done, ${result.dishCount ?? 0} dishes${thin}`);
    } else {
      failed++;
      consecutiveFailures++;
      console.log(`${result.outcome}: ${result.message ?? 'no detail'}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `${consecutiveFailures} failures in a row — something is broken, not just these restaurants`;
        break;
      }
    }
  }

  // Re-read the queue ONCE so "remaining" reflects reality rather than
  // arithmetic over what we thought we did.
  const finalRows = await listGuideQueue(CITY).catch(() => all);
  const after = queueSummary(finalRows);
  const remaining = selectQueue(finalRows, { mode: MODE }).length;

  // Ledger spend for the window, INCLUDING calls the per-restaurant totals
  // missed. CLAUDE.md's rule: a reported number that doesn't reconcile against
  // the ledger means there is an uncounted path, so print both and let the gap
  // show rather than trusting the tidy figure.
  const ledgerCost = await aiSpendSince(runStart).catch(() => Number.NaN);

  console.log('\n================ SUMMARY ================');
  console.log(`  city              ${CITY} (mode=${MODE})`);
  console.log(`  attempted         ${processed} of ${queue.length} selected`);
  console.log(`  analysed          ${analysed}`);
  console.log(`  failed            ${failed}`);
  console.log(`  still waiting     ${remaining}`);
  console.log(`  guide now         ${after.analysed} analysed of ${after.total} curated`);
  console.log(`  cost (attributed) $${attributedCost.toFixed(4)}`);
  console.log(
    `  cost (ai_usage_log) ${Number.isNaN(ledgerCost) ? 'could not read' : `$${ledgerCost.toFixed(4)}`}` +
      `   ← the authoritative number; a gap means an uncounted call path`
  );
  if (stopReason) console.log(`  STOPPED EARLY     ${stopReason}`);
  console.log('=========================================');

  // A cluster of failures is a pipeline bug until proven otherwise — never
  // "these restaurants don't publish menus". Say it loudly here so it cannot be
  // missed in a run log.
  if (processed >= 5 && failed > processed / 2) {
    console.log(
      `\n! ${failed} of ${processed} restaurants failed. That is far more likely a pipeline ` +
        `problem (reader down or rate-limited, missing key, AI account off) than a run of ` +
        `restaurants without menus. Do not treat this guide as "analysed".`
    );
  }

  emitOutputs({ remaining, analysed, failed, attributed_cost: attributedCost.toFixed(4) });

  // Exit non-zero ONLY for a real breakdown, so the workflow files an issue and
  // does NOT keep re-dispatching a broken run. Individual no_menu outcomes are
  // ordinary results, not run failures.
  if (stopReason && !stopReason.startsWith('time budget')) {
    console.error(`\n✗ ${stopReason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
