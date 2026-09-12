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
//
// This file is deliberately thin: the loop and every stopping rule live in
// lib/guide-batch.ts, where they are unit-tested with the analysis mocked. A
// batch driver that can only be checked by spending money is one that does not
// get checked.
import './_preload-env';
import { appendFileSync } from 'node:fs';
import { aiSpendSince, listGuideQueue } from '../lib/db';
import { selectQueue, queueSummary, type QueueMode, type QueueRow } from '../lib/guide-queue';
import { runQueuePass, suspiciousBatch } from '../lib/guide-batch';
import { reanalyseRestaurant } from '../lib/reanalyse';
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Hands `remaining` back to the workflow so it can report an unfinished pass. */
function emitOutputs(values: Record<string, string | number>): void {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    appendFileSync(
      out,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n'
    );
  } catch {
    // Local runs have no $GITHUB_OUTPUT; the console output is the record.
  }
}

function label(row: QueueRow): string {
  return row.name ?? row.url.replace(/^https?:\/\//, '');
}

async function main() {
  if (!CITY) {
    console.error(
      'Usage: npx tsx scripts/analyze-guide-queue.ts --city=<slug> [--yes] [--mode=queued|failed] [--limit=N]'
    );
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
      `  reclaiming ${reclaimed.length} restaurant(s) left mid-analysis by an interrupted run:\n` +
        reclaimed.map((r) => `         · ${label(r)}`).join('\n')
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
    for (const row of queue) console.log(`  would analyse ${label(row)}  (${row.url})`);
    console.log(
      `\n  Re-run with --yes to execute. Rough cost: ~$${(queue.length * 0.05).toFixed(2)} if they ` +
        `succeed — FAILURES COST MORE (every retry rung is a full-price call).`
    );
    emitOutputs({ remaining: queue.length, analysed: 0, failed: 0 });
    return;
  }

  const runStart = new Date();
  const report = await runQueuePass(
    queue,
    {
      analyse: reanalyseRestaurant,
      checkSpend: checkDailySpend,
      sleep,
      now: Date.now,
      onEvent: (e) => {
        if (e.phase === 'start') {
          process.stdout.write(`  [${e.index}/${e.total}] ${label(e.row)} … `);
          return;
        }
        if (e.outcome === 'done') {
          console.log(`done, ${e.dishCount ?? 0} dishes${e.thin ? '  ⚠ THIN' : ''}`);
        } else {
          console.log(`${e.outcome}: ${e.message ?? 'no detail'}`);
        }
      },
    },
    { budgetMs: BUDGET_MINUTES * 60_000 }
  );

  // Re-read the queue ONCE so "remaining" reflects reality rather than
  // arithmetic over what we thought we did.
  const finalRows = await listGuideQueue(CITY).catch(() => all);
  const after = queueSummary(finalRows);
  const remaining = selectQueue(finalRows, { mode: MODE }).length;

  // Ledger spend for the window, INCLUDING calls the per-restaurant totals
  // missed. CLAUDE.md's rule: a reported number that doesn't reconcile against
  // the ledger means there is an uncounted path, so print both and let any gap
  // show rather than trusting the tidy figure.
  const ledgerCost = await aiSpendSince(runStart).catch(() => Number.NaN);

  console.log('\n================ SUMMARY ================');
  console.log(`  city                ${CITY} (mode=${MODE})`);
  console.log(`  attempted           ${report.processed} of ${queue.length} selected`);
  console.log(
    `  analysed            ${report.analysed}${report.thin ? ` (${report.thin} suspiciously thin)` : ''}`
  );
  console.log(`  failed              ${report.failed}`);
  console.log(`  still waiting       ${remaining}`);
  console.log(`  guide now           ${after.analysed} analysed of ${after.total} curated`);
  console.log(`  cost (attributed)   $${report.attributedCostUsd.toFixed(4)}`);
  console.log(
    `  cost (ai_usage_log) ${Number.isNaN(ledgerCost) ? 'could not read' : `$${ledgerCost.toFixed(4)}`}` +
      `   ← authoritative; a gap means an uncounted call path`
  );
  if (report.stopReason) console.log(`  STOPPED EARLY       ${report.stopReason}`);
  console.log('=========================================');

  const suspicious = suspiciousBatch(report);
  if (suspicious) console.log(`\n! ${suspicious}`);

  emitOutputs({
    remaining,
    analysed: report.analysed,
    failed: report.failed,
    thin: report.thin,
    attributed_cost: report.attributedCostUsd.toFixed(4),
  });

  // Exit non-zero ONLY for a breakdown, so the workflow files an issue for
  // something a human must look at. An individual no_menu outcome is an ordinary
  // result, and running out of the time budget is an ordinary boundary.
  if (report.broken) {
    console.error(`\n✗ ${report.stopReason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
