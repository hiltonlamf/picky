import { describe, it, expect, vi } from 'vitest';
import {
  INTER_RESTAURANT_DELAY_MS,
  MAX_CONSECUTIVE_FAILURES,
  runQueuePass,
  suspiciousBatch,
  type BatchDeps,
  type BatchEvent,
} from '@/lib/guide-batch';
import type { QueueRow } from '@/lib/guide-queue';
import type { ReanalyseResult } from '@/lib/reanalyse';

/**
 * The batch driver, with the analysis mocked.
 *
 * This is the only genuinely new logic in the server-side batch — the analysis
 * itself is a straight move of the reparse route — and it is where the
 * expensive mistakes live: a spend check that doesn't run, a failure ladder
 * nobody breaks out of, a delay that stops guarding the page reader. Every one
 * of those is invisible in a green build and costs real money to discover, so
 * they are tested here for free rather than by running a city.
 */

function row(id: string, over: Partial<QueueRow> = {}): QueueRow {
  return {
    id,
    name: `Restaurant ${id}`,
    url: `https://${id}.ie`,
    status: 'pending',
    updatedAt: null,
    displayOrder: 0,
    ...over,
  };
}

const ok = (dishCount = 20): ReanalyseResult => ({ outcome: 'done', dishCount, costUsd: 0.05 });
const noMenu = (): ReanalyseResult => ({ outcome: 'no_menu', message: 'no menu', costUsd: 0.03 });

/** Deps with everything instant and nothing billed. */
function deps(over: Partial<BatchDeps> = {}): BatchDeps & { events: BatchEvent[]; sleeps: number[] } {
  const events: BatchEvent[] = [];
  const sleeps: number[] = [];
  return {
    analyse: vi.fn(async () => ok()),
    checkSpend: vi.fn(async () => ({ allowed: true, spentUsd: 1, capUsd: 25 })),
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
    }),
    now: () => 0,
    onEvent: (e) => events.push(e),
    events,
    sleeps,
    ...over,
  };
}

const BUDGET = { budgetMs: 60 * 60_000 };

describe('runQueuePass', () => {
  it('analyses every restaurant, in the order given', async () => {
    const d = deps();
    const report = await runQueuePass([row('a'), row('b'), row('c')], d, BUDGET);
    expect(report).toMatchObject({ processed: 3, analysed: 3, failed: 0, thin: 0 });
    expect((d.analyse as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(report.stopReason).toBeNull();
    expect(report.broken).toBe(false);
  });

  it('never runs two analyses at once', async () => {
    // Sequential is a cost decision, not a style one: parallel analyses make
    // spend spike unpredictably and multiply page-reader calls per second.
    let inFlight = 0;
    let maxInFlight = 0;
    const d = deps({
      analyse: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return ok();
      },
    });
    await runQueuePass([row('a'), row('b'), row('c')], d, BUDGET);
    expect(maxInFlight).toBe(1);
  });

  it('pauses between restaurants but not before the first', async () => {
    const d = deps();
    await runQueuePass([row('a'), row('b'), row('c')], d, BUDGET);
    expect(d.sleeps).toEqual([INTER_RESTAURANT_DELAY_MS, INTER_RESTAURANT_DELAY_MS]);
  });

  it('counts a failure’s spend, not just a success’s', async () => {
    // Failure is the most expensive path in this pipeline and historically the
    // least recorded. A run that reported only successes would understate its
    // own cost, which is the mistake that made a "$1.27" run move the balance
    // by $3.51.
    const d = deps({ analyse: async () => noMenu() });
    const report = await runQueuePass([row('a'), row('b')], d, BUDGET);
    expect(report.failed).toBe(2);
    expect(report.attributedCostUsd).toBeCloseTo(0.06, 5);
  });

  it('flags a thin "success" instead of counting it as a working restaurant', async () => {
    // 2 dishes where a real menu has 20 is a mis-read, and averaging it into
    // "analysed" hides the failure users notice most.
    const d = deps({ analyse: async (id) => (id === 'a' ? ok(2) : ok(30)) });
    const report = await runQueuePass([row('a'), row('b')], d, BUDGET);
    expect(report).toMatchObject({ analysed: 2, thin: 1 });
    const results = d.events.filter((e) => e.phase === 'result');
    expect(results.map((e) => (e.phase === 'result' ? e.thin : null))).toEqual([true, false]);
  });
});

describe('the spend cap', () => {
  it('is consulted before every restaurant, not once at the start', async () => {
    // Checking once would let a run that starts under the cap blow far past it,
    // and this cap is the only thing standing between a bug and the balance.
    const d = deps();
    await runQueuePass([row('a'), row('b'), row('c')], d, BUDGET);
    expect(d.checkSpend).toHaveBeenCalledTimes(3);
  });

  it('stops the run the moment the cap is hit, and reports it as a breakdown', async () => {
    let calls = 0;
    const d = deps({
      checkSpend: async () => {
        calls++;
        return { allowed: calls < 3, spentUsd: 25.4, capUsd: 25 };
      },
    });
    const report = await runQueuePass([row('a'), row('b'), row('c'), row('d')], d, BUDGET);
    expect(report.processed).toBe(2);
    expect(report.stopReason).toMatch(/daily spend cap/i);
    // Broken, so the workflow exits non-zero and files an issue: silently
    // analysing half a city is how you find out from the credit balance.
    expect(report.broken).toBe(true);
  });

  it('does not analyse anything at all when the cap is already blown', async () => {
    const d = deps({ checkSpend: async () => ({ allowed: false, spentUsd: 30, capUsd: 25 }) });
    const report = await runQueuePass([row('a')], d, BUDGET);
    expect(d.analyse).not.toHaveBeenCalled();
    expect(report.processed).toBe(0);
  });
});

describe('breaking out of a broken run', () => {
  it('gives up after a run of consecutive failures', async () => {
    // A dead reader or an expired key fails all 40 at full price and cannot
    // succeed. 40 hopeless sites × a retry ladder is a surprise bill.
    const d = deps({ analyse: async () => noMenu() });
    const queue = Array.from({ length: 40 }, (_, i) => row(`r${i}`));
    const report = await runQueuePass(queue, d, BUDGET);
    expect(report.processed).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(report.stopReason).toMatch(/failures in a row/i);
    expect(report.broken).toBe(true);
  });

  it('keeps going when failures are scattered among successes', async () => {
    // Real guides contain the odd restaurant without a readable menu. Stopping
    // for those would make the feature useless.
    let n = 0;
    const d = deps({ analyse: async () => (++n % 3 === 0 ? noMenu() : ok()) });
    const queue = Array.from({ length: 12 }, (_, i) => row(`r${i}`));
    const report = await runQueuePass(queue, d, BUDGET);
    expect(report.processed).toBe(12);
    expect(report.stopReason).toBeNull();
  });

  it('resets the streak on a success', async () => {
    const outcomes = ['no_menu', 'no_menu', 'no_menu', 'no_menu', 'done', 'no_menu', 'no_menu'];
    let i = 0;
    const d = deps({ analyse: async () => (outcomes[i++] === 'done' ? ok() : noMenu()) });
    const report = await runQueuePass(
      outcomes.map((_, k) => row(`r${k}`)),
      d,
      BUDGET
    );
    expect(report.processed).toBe(7);
    expect(report.broken).toBe(false);
  });

  it('survives an analysis that throws, without losing the rest of the batch', async () => {
    const d = deps({
      analyse: async (id) => {
        if (id === 'b') throw new Error('socket hang up');
        return ok();
      },
    });
    const report = await runQueuePass([row('a'), row('b'), row('c')], d, BUDGET);
    expect(report).toMatchObject({ processed: 3, analysed: 2, failed: 1 });
    expect(report.broken).toBe(false);
  });
});

describe('the time budget', () => {
  it('stops when the budget runs out, and does NOT call that a breakdown', async () => {
    // The remainder is still queued in the database, so the next pass continues.
    // Treating it as a failure would file an issue every time a big city needed
    // two passes.
    let clock = 0;
    const d = deps({
      now: () => clock,
      analyse: async () => {
        clock += 30_000;
        return ok();
      },
    });
    const report = await runQueuePass(
      Array.from({ length: 10 }, (_, i) => row(`r${i}`)),
      d,
      { budgetMs: 90_000 }
    );
    expect(report.processed).toBeLessThan(10);
    expect(report.stopReason).toMatch(/time budget/i);
    expect(report.broken).toBe(false);
  });

  it('finishes the restaurant it is on rather than abandoning it mid-analysis', async () => {
    // A restaurant killed mid-flight is left `processing` and its work wasted.
    // The budget is checked between restaurants, never inside one.
    let clock = 0;
    let completed = 0;
    const d = deps({
      now: () => clock,
      analyse: async () => {
        clock += 10 * 60_000; // blows the budget during this one
        completed++;
        return ok();
      },
    });
    const report = await runQueuePass([row('a'), row('b')], d, { budgetMs: 60_000 });
    expect(completed).toBe(1);
    expect(report.analysed).toBe(1);
  });
});

describe('suspiciousBatch', () => {
  it('calls out a batch that mostly failed as a pipeline problem', async () => {
    const d = deps({ analyse: async (id) => (id === 'r0' ? ok(30) : noMenu()) });
    // Scattered enough to avoid the consecutive-failure stop, then judged whole.
    const report = await runQueuePass(
      Array.from({ length: 5 }, (_, i) => row(`r${i}`)),
      d,
      BUDGET
    );
    const warning = suspiciousBatch(report);
    expect(warning).toMatch(/pipeline problem/i);
    // Never the other reading: real restaurants with real websites almost
    // always publish a menu somewhere.
    expect(warning).not.toMatch(/do not publish|don't publish/i);
  });

  it('counts thin menus towards the signal, not just outright failures', async () => {
    // Many restaurants returning 2 dishes is the same broken-pipeline tell as
    // many returning nothing.
    const d = deps({ analyse: async () => ok(2) });
    const report = await runQueuePass(
      Array.from({ length: 6 }, (_, i) => row(`r${i}`)),
      d,
      BUDGET
    );
    expect(report.failed).toBe(0);
    expect(suspiciousBatch(report)).toMatch(/pipeline problem/i);
  });

  it('stays quiet for a healthy run', async () => {
    const d = deps();
    const report = await runQueuePass(
      Array.from({ length: 8 }, (_, i) => row(`r${i}`)),
      d,
      BUDGET
    );
    expect(suspiciousBatch(report)).toBeNull();
  });

  it('stays quiet on a sample too small to mean anything', async () => {
    const d = deps({ analyse: async () => noMenu() });
    const report = await runQueuePass([row('a'), row('b')], d, BUDGET);
    expect(suspiciousBatch(report)).toBeNull();
  });
});
