import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzeSequentially } from '@/app/admin/guides/batchAnalyze';
import {
  applyProgress,
  settleLive,
  startLive,
  statusBadge,
  type LiveState,
} from '@/app/admin/guides/statusBadge';

describe('guide workspace status badge', () => {
  it('shows "Queued" for restaurants waiting their turn in the running batch', () => {
    // Their stored status is still whatever it was before the run started —
    // the live state must win, or the whole queue looks untouched.
    expect(statusBadge('no_menu', { phase: 'queued' }).label).toBe('Queued');
    expect(statusBadge('pending', { phase: 'queued' }).label).toBe('Queued');
    expect(statusBadge('done', { phase: 'queued' }).label).toBe('Queued');
  });

  it('shows "Analyzing" with a live indicator for the one being worked on', () => {
    const badge = statusBadge('no_menu', { phase: 'analyzing' });
    expect(badge.label).toBe('Analyzing');
    expect(badge.active).toBe(true);
  });

  it('shows the outcome as soon as the browser has it, before the DB refresh lands', () => {
    expect(statusBadge('pending', { phase: 'result', outcome: 'done', dishCount: 21 }).label).toBe('Analyzed');
    expect(statusBadge('pending', { phase: 'result', outcome: 'no_menu' }).label).toBe('No menu');
    expect(statusBadge('pending', { phase: 'result', outcome: 'error' }).label).toBe('Error');
  });

  it('only the analyzing badge animates — a finished or queued row must sit still', () => {
    expect(statusBadge('pending', { phase: 'queued' }).active).toBeFalsy();
    expect(statusBadge('pending', { phase: 'result', outcome: 'done' }).active).toBeFalsy();
    expect(statusBadge('done').active).toBeFalsy();
  });

  describe('with no batch running in this tab', () => {
    it('calls a not-yet-analyzed restaurant "Queued"', () => {
      expect(statusBadge('pending').label).toBe('Queued');
    });

    it('calls a stuck "processing" row "Interrupted", not still-working', () => {
      // The bug this fixes: a row left mid-analysis by a closed tab showed
      // PROCESSING indefinitely, so it read as "still loading" for hours.
      const badge = statusBadge('processing');
      expect(badge.label).toBe('Interrupted');
      expect(badge.active).toBeFalsy();
      expect(badge.title).toContain('never finished');
    });

    it('uses plain-English labels for stored outcomes', () => {
      expect(statusBadge('done').label).toBe('Analyzed');
      expect(statusBadge('no_menu').label).toBe('No menu');
      expect(statusBadge('error').label).toBe('Error');
    });

    it('falls back to the raw status for anything unrecognised', () => {
      expect(statusBadge('something_new').label).toBe('something_new');
    });
  });
});

describe('live batch state, driven by the real analyzer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Runs a real 3-restaurant batch against a stubbed reparse endpoint and
   * records what the three rows would show after every progress event.
   */
  async function runBatch(outcomes: Array<{ outcome: string; dishCount?: number }>, stopAfter = Infinity) {
    const ids = outcomes.map((_, i) => `r${i + 1}`);
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ...outcomes[call++], costUsd: 0.01 }) }))
    );

    let live = startLive(ids);
    const frames: string[][] = [ids.map((id) => statusBadge('pending', live[id]).label)];
    let results = 0;

    await analyzeSequentially(
      ids,
      (p) => {
        live = applyProgress(live, p);
        if (p.phase === 'result') results++;
        frames.push(ids.map((id) => statusBadge('pending', live[id]).label));
      },
      () => results >= stopAfter
    );

    live = settleLive(live);
    return { frames, settled: ids.map((id) => statusBadge('pending', live[id]).label) };
  }

  it('shows exactly one Analyzing, with the rest Queued, and completes in order', async () => {
    const { frames, settled } = await runBatch([
      { outcome: 'done', dishCount: 21 },
      { outcome: 'no_menu' },
      { outcome: 'done', dishCount: 9 },
    ]);

    expect(frames).toEqual([
      ['Queued', 'Queued', 'Queued'],
      ['Analyzing', 'Queued', 'Queued'],
      ['Analyzed', 'Queued', 'Queued'],
      ['Analyzed', 'Analyzing', 'Queued'],
      ['Analyzed', 'No menu', 'Queued'],
      ['Analyzed', 'No menu', 'Analyzing'],
      ['Analyzed', 'No menu', 'Analyzed'],
    ]);
    // Never more than one restaurant in flight — AI spend stays sequential.
    for (const f of frames) expect(f.filter((l) => l === 'Analyzing').length).toBeLessThanOrEqual(1);
    expect(settled).toEqual(['Analyzed', 'No menu', 'Analyzed']);
  }, 20_000);

  it('stops claiming rows are Queued once the run is stopped early', async () => {
    const { settled } = await runBatch(
      [{ outcome: 'done', dishCount: 12 }, { outcome: 'done' }, { outcome: 'done' }],
      1
    );
    // Only the first finished; the untouched two fall back to their stored
    // status ("pending" → Queued is honest) rather than a stale live badge.
    expect(settled[0]).toBe('Analyzed');
    expect(settled.slice(1)).toEqual(['Queued', 'Queued']);
  }, 20_000);

  it('treats an unrecognised or missing outcome as an Error, never as success', () => {
    const live = applyProgress(startLive(['r1']), {
      index: 1,
      total: 1,
      restaurantId: 'r1',
      phase: 'result',
    } as never);
    expect(statusBadge('pending', live.r1 as LiveState).label).toBe('Error');
  });
});
