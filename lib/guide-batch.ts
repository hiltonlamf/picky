import { MIN_GUIDE_DISHES } from './review-flags';
import type { QueueRow } from './guide-queue';
import type { ReanalyseResult } from './reanalyse';

/**
 * One pass of the guide batch: analyse a list of restaurants, one at a time,
 * and stop for a reason rather than grinding.
 *
 * The loop lives here, apart from the CLI in scripts/analyze-guide-queue.ts,
 * because it is the only genuinely NEW logic in the server-side batch (the
 * analysis itself is untouched) and it is where the expensive mistakes are: a
 * missing spend check, a delay that stops guarding the page reader, a failure
 * ladder nobody breaks out of. Every dependency that costs money or waits is
 * injected, so all of that is testable for free — the alternative was a
 * top-level script that could only be checked by spending.
 */

/** Everything the pass needs from the outside world. */
export interface BatchDeps {
  /** Analyse one restaurant. In production, `reanalyseRestaurant`. */
  analyse: (restaurantId: string) => Promise<ReanalyseResult>;
  /** The global daily $ ceiling. Consulted BEFORE each restaurant. */
  checkSpend: () => Promise<{ allowed: boolean; spentUsd: number; capUsd: number }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Per-restaurant reporting, so a long run is legible while it happens. */
  onEvent?: (event: BatchEvent) => void;
}

export type BatchEvent =
  | { phase: 'start'; index: number; total: number; row: QueueRow }
  | {
      phase: 'result';
      index: number;
      total: number;
      row: QueueRow;
      outcome: ReanalyseResult['outcome'];
      dishCount?: number;
      costUsd?: number;
      message?: string;
      /** Finished, but with too few dishes to be a real menu. */
      thin: boolean;
    };

export interface BatchOptions {
  /** Wall-clock budget. The pass finishes the restaurant it is on, then stops. */
  budgetMs: number;
  delayMs?: number;
  maxConsecutiveFailures?: number;
}

export interface BatchReport {
  processed: number;
  analysed: number;
  failed: number;
  /** Analysed but suspiciously thin — a "success" nobody should trust. */
  thin: number;
  /** Summed from what each restaurant reported. Reconcile against ai_usage_log. */
  attributedCostUsd: number;
  stopReason: string | null;
  /**
   * Whether the stop is a BREAKDOWN (something is wrong and a human should
   * look) rather than an ordinary boundary. Running out of time is normal;
   * every restaurant failing, or hitting the daily spend cap, is not. The
   * caller turns this into an exit code, so it must not be inferred by
   * sniffing the reason string.
   */
  broken: boolean;
}

/**
 * Small pause between restaurants. When a site analyses successfully the work
 * already takes 30-60s, so this adds nothing meaningful; its real job is to stop
 * a run of FAST failures (dead sites) from firing dozens of page-reader calls
 * per minute and tripping the reader's rate limit — the exact failure that made
 * a whole Amsterdam batch come back empty.
 */
export const INTER_RESTAURANT_DELAY_MS = 1500;

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
export const MAX_CONSECUTIVE_FAILURES = 5;

export async function runQueuePass(
  queue: QueueRow[],
  deps: BatchDeps,
  options: BatchOptions
): Promise<BatchReport> {
  const delayMs = options.delayMs ?? INTER_RESTAURANT_DELAY_MS;
  const maxConsecutive = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  const deadline = deps.now() + options.budgetMs;

  let processed = 0;
  let analysed = 0;
  let failed = 0;
  let thinCount = 0;
  let attributedCostUsd = 0;
  let consecutiveFailures = 0;
  let stopReason: string | null = null;
  let broken = false;

  for (const row of queue) {
    if (deps.now() >= deadline) {
      // Not a failure: the pass simply ran out of its window. Whatever is left
      // is still queued in the database, so the next pass continues.
      stopReason = 'time budget reached — the rest is still queued';
      break;
    }

    // The global $/day backstop. No script checked this before, so a
    // script-driven batch bypassed the cap that guards the API routes entirely.
    const spend = await deps.checkSpend();
    if (!spend.allowed) {
      stopReason = `daily spend cap reached ($${spend.spentUsd.toFixed(2)} of $${spend.capUsd.toFixed(2)})`;
      broken = true;
      break;
    }

    if (processed > 0) await deps.sleep(delayMs);
    processed++;
    deps.onEvent?.({ phase: 'start', index: processed, total: queue.length, row });

    let result: ReanalyseResult;
    try {
      result = await deps.analyse(row.id);
    } catch (err) {
      // The analysis records its own outcome on the row; this catch is for the
      // unexpected (a network fault mid-write). One restaurant must never take
      // the whole batch down.
      result = { outcome: 'error', message: err instanceof Error ? err.message : 'failed' };
    }

    if (typeof result.costUsd === 'number') attributedCostUsd += result.costUsd;

    // A "success" with 2 dishes is a mis-read menu, not a working restaurant —
    // counted separately so a run cannot look healthier than it is.
    const thin = result.outcome === 'done' && (result.dishCount ?? 0) < MIN_GUIDE_DISHES;

    if (result.outcome === 'done') {
      analysed++;
      if (thin) thinCount++;
      consecutiveFailures = 0;
    } else {
      failed++;
      consecutiveFailures++;
    }

    deps.onEvent?.({
      phase: 'result',
      index: processed,
      total: queue.length,
      row,
      outcome: result.outcome,
      dishCount: result.dishCount,
      costUsd: result.costUsd,
      message: result.message,
      thin,
    });

    if (consecutiveFailures >= maxConsecutive) {
      stopReason = `${consecutiveFailures} failures in a row — something is broken, not just these restaurants`;
      broken = true;
      break;
    }
  }

  return { processed, analysed, failed, thin: thinCount, attributedCostUsd, stopReason, broken };
}

/**
 * Whether a finished pass looks like a pipeline problem rather than a run of
 * restaurants that genuinely have no menu.
 *
 * CLAUDE.md's standing rule: a cluster of failures is a BUG until proven
 * otherwise. Real restaurants with real websites almost always have a readable
 * menu somewhere, so most of a batch failing points at the reader being
 * rate-limited, a missing key, or the AI account being off — not at the
 * restaurants. Returned as a string so the run log says it in words rather than
 * leaving it to be read off the numbers.
 */
export function suspiciousBatch(report: BatchReport): string | null {
  if (report.processed < 5) return null;
  const bad = report.failed + report.thin;
  if (bad <= report.processed / 2) return null;
  return (
    `${bad} of ${report.processed} restaurants failed or came back suspiciously thin. That is far ` +
    `more likely a pipeline problem (reader down or rate-limited, missing key, AI account off) ` +
    `than a run of restaurants without menus. Do not treat this guide as analysed.`
  );
}
