/**
 * The deployed app failed on four sites the QA suite passes.
 *
 * Cause: the QA suite is a plain Node script with no time limit, while Vercel
 * gives the route 40s inside a hard 60s cap. A single reader call asking for 90s
 * outlived the function, which was killed mid-flight — the user saw "the
 * connection dropped" at 114.5s instead of a menu (founder, 2026-08-06).
 *
 * These tests pin the two properties that matter: inside a request nothing can
 * outlive its deadline, and outside one nothing is constrained — because the
 * second is exactly why the QA harness could not have caught the first.
 */
import { describe, it, expect } from 'vitest';
import { withDeadline, clampTimeout, remainingMs, outOfTime } from '@/lib/deadline';

describe('request deadline', () => {
  it('leaves timeouts alone outside a request (scripts, tests, the QA runner)', () => {
    expect(remainingMs()).toBeNull();
    expect(clampTimeout(90_000)).toBe(90_000);
    expect(outOfTime()).toBe(false);
  });

  it('caps a document read at the time actually left, not the 90s it asked for', async () => {
    await withDeadline(Date.now() + 20_000, async () => {
      const clamped = clampTimeout(90_000);
      expect(clamped).toBeLessThanOrEqual(20_000);
      expect(clamped).toBeGreaterThan(15_000); // still generous with what remains
    });
  });

  it('does not inflate a timeout that is already shorter than the budget', async () => {
    await withDeadline(Date.now() + 50_000, async () => {
      expect(clampTimeout(25_000)).toBe(25_000);
    });
  });

  it('keeps a floor rather than issuing a doomed 200ms request', async () => {
    await withDeadline(Date.now() + 100, async () => {
      expect(clampTimeout(90_000)).toBe(3000);
    });
  });

  it('reports being out of time so callers can hand back instead of starting work', async () => {
    await withDeadline(Date.now() + 500, async () => {
      expect(outOfTime()).toBe(true);
    });
    await withDeadline(Date.now() + 30_000, async () => {
      expect(outOfTime()).toBe(false);
    });
  });

  it('survives nesting — the innermost deadline wins', async () => {
    await withDeadline(Date.now() + 60_000, async () => {
      await withDeadline(Date.now() + 5_000, async () => {
        expect(clampTimeout(60_000)).toBeLessThanOrEqual(5_000);
      });
      // …and the outer budget is intact afterwards.
      expect(clampTimeout(60_000)).toBeGreaterThan(50_000);
    });
  });
});
