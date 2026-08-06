import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How much wall-clock time this request has left.
 *
 * Serverless functions die on a hard cap (60s on Vercel Hobby; we aim to finish
 * inside 40s and resume). The extraction ladder already respects that — it
 * checks the deadline between attempts and persists progress so the client can
 * call back. But "between attempts" is the whole problem: a SINGLE attempt with
 * a 90-second reader timeout or a 120-second upload runs straight past the cap,
 * the function is killed mid-flight, and the user gets a dropped connection
 * rather than a result. Found the hard way — the QA harness is a plain Node
 * script with no time limit, so it can never reproduce this, and a suite that
 * passed 5/6 sat alongside a deployed app that failed all four the founder
 * tried (2026-08-06).
 *
 * So: one ambient deadline for the request, and every outbound call clamps its
 * own timeout to what is actually left. AsyncLocalStorage rather than threading
 * a parameter through scraper → discovery → extract → ai → reader, and the same
 * pattern `withSpendContext` already uses here.
 *
 * Degrades safely: with no deadline set (scripts, tests, the QA runner) the
 * requested timeout is used unchanged, so nothing outside a serverless request
 * is constrained.
 */
const store = new AsyncLocalStorage<{ at: number }>();

/** Run `fn` with a wall-clock deadline (epoch ms). Safe to nest. */
export function withDeadline<T>(at: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ at }, fn);
}

/** Milliseconds left, or null when no deadline is in force. */
export function remainingMs(): number | null {
  const ctx = store.getStore();
  if (!ctx) return null;
  return ctx.at - Date.now();
}

/**
 * The timeout to actually use for one outbound call.
 *
 * Never returns more than the time left, so no single call can outlive the
 * function that made it. Keeps a small floor: a 200ms timeout would fail every
 * request for no benefit, and a request this close to its deadline is going to
 * hand back to the client anyway — better to make one honest attempt than a
 * guaranteed-doomed one.
 */
const MIN_TIMEOUT_MS = 3000;

export function clampTimeout(desiredMs: number): number {
  const left = remainingMs();
  if (left === null) return desiredMs; // not in a deadline context — unchanged
  return Math.max(MIN_TIMEOUT_MS, Math.min(desiredMs, left));
}

/** True when there is not enough time left to be worth starting `costMs` of work. */
export function outOfTime(costMs = MIN_TIMEOUT_MS): boolean {
  const left = remainingMs();
  return left !== null && left < costMs;
}
