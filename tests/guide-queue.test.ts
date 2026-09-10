import { describe, it, expect } from 'vitest';
import {
  STALE_PROCESSING_MS,
  hasLiveRun,
  isEligible,
  isLiveProcessing,
  isStaleProcessing,
  queueSummary,
  selectQueue,
  type QueueRow,
} from '@/lib/guide-queue';

/**
 * The queue is derived from `restaurants.status` plus `updated_at` — there is no
 * jobs table. Everything below protects one of two properties:
 *
 *  1. **Nothing gets stranded.** A restaurant abandoned mid-analysis (the admin
 *     closed the tab that was driving it) must be picked up again. This is the
 *     bug the founder hit: 37 Cork restaurants sat `processing` for hours with
 *     nothing anywhere that would ever run them.
 *  2. **Nothing gets billed twice.** A restaurant a live run is working on this
 *     minute must NOT be handed to a second worker. Every AI call is paid for
 *     personally, so a double-run is real money for an identical result.
 */

const NOW = Date.parse('2026-09-10T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function row(over: Partial<QueueRow> & { id: string }): QueueRow {
  return {
    name: `Restaurant ${over.id}`,
    url: `https://${over.id}.ie`,
    status: 'pending',
    updatedAt: null,
    displayOrder: 0,
    ...over,
  };
}

describe('processing freshness', () => {
  it('treats a just-started analysis as live, not as work to redo', () => {
    expect(isLiveProcessing('processing', minutesAgo(1), NOW)).toBe(true);
    expect(isStaleProcessing('processing', minutesAgo(1), NOW)).toBe(false);
  });

  it('reclaims a run abandoned long ago', () => {
    expect(isStaleProcessing('processing', minutesAgo(60), NOW)).toBe(true);
    expect(isLiveProcessing('processing', minutesAgo(60), NOW)).toBe(false);
  });

  it('leaves the slowest realistic analysis alone', () => {
    // A struggling site walks a retry ladder for several minutes. Reclaiming at
    // that point would pay for the same restaurant twice, concurrently.
    expect(isStaleProcessing('processing', minutesAgo(5), NOW)).toBe(false);
    expect(STALE_PROCESSING_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('says nothing about a row that is not processing', () => {
    for (const status of ['pending', 'done', 'error', 'no_menu']) {
      expect(isStaleProcessing(status, minutesAgo(600), NOW)).toBe(false);
      expect(isLiveProcessing(status, minutesAgo(0), NOW)).toBe(false);
    }
  });

  it('treats a missing or unreadable timestamp as abandoned, never as live', () => {
    // The dangerous direction is the other one: reading a broken timestamp as
    // "just updated" would pin the row live forever and nothing would run it.
    expect(isStaleProcessing('processing', null, NOW)).toBe(true);
    expect(isStaleProcessing('processing', 'not a date', NOW)).toBe(true);
  });
});

describe('selectQueue', () => {
  const rows = [
    row({ id: 'a', status: 'done', displayOrder: 0 }),
    row({ id: 'b', status: 'pending', displayOrder: 1 }),
    row({ id: 'c', status: 'processing', updatedAt: minutesAgo(90), displayOrder: 2 }),
    row({ id: 'd', status: 'processing', updatedAt: minutesAgo(2), displayOrder: 3 }),
    row({ id: 'e', status: 'no_menu', displayOrder: 4 }),
    row({ id: 'f', status: 'error', displayOrder: 5 }),
  ];

  it('runs what is waiting and reclaims what was abandoned', () => {
    expect(selectQueue(rows, { now: NOW }).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('never hands a live run’s restaurant to a second worker', () => {
    // 'd' is being analysed right now. Picking it up is the double-billing bug.
    expect(selectQueue(rows, { now: NOW }).map((r) => r.id)).not.toContain('d');
  });

  it('leaves finished and failed restaurants out of the default pass', () => {
    const ids = selectQueue(rows, { now: NOW }).map((r) => r.id);
    expect(ids).not.toContain('a');
    expect(ids).not.toContain('e');
    expect(ids).not.toContain('f');
  });

  it('re-runs failures only when asked for them explicitly', () => {
    // Retrying a genuinely menuless site spends full price on an outcome it
    // cannot change, so it must never ride along with a normal pass.
    expect(selectQueue(rows, { mode: 'failed', now: NOW }).map((r) => r.id)).toEqual(['e', 'f']);
  });

  it('walks the guide in its curated order', () => {
    const shuffled = [
      row({ id: 'z', displayOrder: 9 }),
      row({ id: 'x', displayOrder: 1 }),
      row({ id: 'y', displayOrder: 5 }),
    ];
    expect(selectQueue(shuffled, { now: NOW }).map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });

  it('is deterministic when two restaurants share a position', () => {
    // Otherwise two passes could disagree about who is next and a limited run
    // would keep re-analysing the same subset.
    const tied = [row({ id: 'b2', displayOrder: 3 }), row({ id: 'a1', displayOrder: 3 })];
    expect(selectQueue(tied, { now: NOW }).map((r) => r.id)).toEqual(['a1', 'b2']);
  });

  it('caps a pass at the requested size, taking the front of the queue', () => {
    expect(selectQueue(rows, { limit: 1, now: NOW }).map((r) => r.id)).toEqual(['b']);
  });

  it('treats a limit of zero as none rather than as unlimited', () => {
    expect(selectQueue(rows, { limit: 0, now: NOW })).toEqual([]);
  });

  it('is idempotent — a second pass picks up exactly what is left', () => {
    // This IS the resume mechanism: there is no cursor to lose, so re-running
    // after an interrupted pass cannot skip or repeat work.
    const first = selectQueue(rows, { now: NOW });
    const after = rows.map((r) =>
      first.some((f) => f.id === r.id) ? { ...r, status: 'done', updatedAt: minutesAgo(0) } : r
    );
    expect(selectQueue(after, { now: NOW })).toEqual([]);
  });
});

describe('isEligible', () => {
  it('agrees with selectQueue about every row', () => {
    const all = [
      row({ id: 'p', status: 'pending' }),
      row({ id: 'q', status: 'processing', updatedAt: minutesAgo(1) }),
      row({ id: 'r', status: 'processing', updatedAt: minutesAgo(99) }),
      row({ id: 's', status: 'done' }),
      row({ id: 't', status: 'no_menu' }),
    ];
    for (const mode of ['queued', 'failed'] as const) {
      const selected = new Set(selectQueue(all, { mode, now: NOW }).map((r) => r.id));
      for (const r of all) expect(isEligible(r, mode, NOW)).toBe(selected.has(r.id));
    }
  });
});

describe('queueSummary', () => {
  it('counts each restaurant exactly once', () => {
    const rows = [
      row({ id: 'a', status: 'done' }),
      row({ id: 'b', status: 'done' }),
      row({ id: 'c', status: 'pending' }),
      row({ id: 'd', status: 'processing', updatedAt: minutesAgo(1) }),
      row({ id: 'e', status: 'processing', updatedAt: minutesAgo(120) }),
      row({ id: 'f', status: 'no_menu' }),
      row({ id: 'g', status: 'error' }),
    ];
    const s = queueSummary(rows, NOW);
    expect(s).toEqual({ waiting: 2, running: 1, analysed: 2, failed: 2, total: 7 });
    // The founder reads these numbers off one screen; they have to add up.
    expect(s.waiting + s.running + s.analysed + s.failed).toBe(s.total);
  });

  it('counts a stale processing row as waiting, not as running', () => {
    // Calling it "running" is exactly the lie that sent the founder away to wait
    // hours for work nothing was doing.
    const s = queueSummary([row({ id: 'a', status: 'processing', updatedAt: minutesAgo(120) })], NOW);
    expect(s).toMatchObject({ waiting: 1, running: 0 });
  });

  it('is empty for an empty guide', () => {
    expect(queueSummary([], NOW)).toEqual({ waiting: 0, running: 0, analysed: 0, failed: 0, total: 0 });
  });
});

describe('hasLiveRun', () => {
  it('detects a server run in flight so the UI can hide the in-tab button', () => {
    expect(hasLiveRun([row({ id: 'a', status: 'processing', updatedAt: minutesAgo(1) })], NOW)).toBe(true);
  });

  it('is false once that run goes stale, so the admin is not locked out', () => {
    expect(hasLiveRun([row({ id: 'a', status: 'processing', updatedAt: minutesAgo(90) })], NOW)).toBe(false);
    expect(hasLiveRun([row({ id: 'a', status: 'pending' })], NOW)).toBe(false);
  });
});
