/**
 * What still needs analysing in a city guide, and what is running right now.
 *
 * There is no jobs table. `restaurants.status` already IS the queue, and adding
 * a second place that records "is this restaurant being worked on" would give us
 * two sources of truth to disagree with each other — the failure this codebase
 * keeps hitting (two veggie counts, two copies of `heldBackReason`).
 *
 * The one thing status alone cannot say is whether a `processing` row is alive.
 * `processing` means "an analysis started"; it does NOT mean anything is still
 * running, because until now the batch ran inside an admin's browser tab and
 * closing that tab left rows stuck mid-flight forever. `restaurants.updated_at`
 * is what separates the two — it has a database trigger
 * (`restaurants_updated_at` in db/schema.sql), so every status write stamps it:
 *
 *   pending                                  → waiting its turn
 *   processing, updated within the window    → genuinely being analysed now
 *   processing, older than the window        → abandoned; reclaim it
 *
 * This module is PURE and client-safe (no database, no browser APIs), so the
 * worker, the admin badges and `heldBackReason` all read freshness through the
 * same rules and cannot drift apart.
 */

/**
 * How long a `processing` row is trusted before it is treated as abandoned.
 *
 * The floor is one restaurant's analysis: a slow site takes 30-60s, and the
 * retry ladder on a struggling one can take several minutes, so anything under
 * ~5 minutes would reclaim rows that are still legitimately working and pay for
 * the same restaurant twice. The ceiling is the founder's patience — a stuck
 * row should be picked up by the next pass, not tomorrow. 15 minutes clears the
 * slowest real analysis by a wide margin while still self-healing within one
 * pass.
 */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

/** How the worker chooses what to run. */
export type QueueMode = 'queued' | 'failed';

export interface QueueRow {
  id: string;
  name: string | null;
  url: string;
  status: string;
  /** `restaurants.updated_at`. Null is treated as infinitely old. */
  updatedAt: string | null;
  /** The guide's curated position, so analysis order matches the admin's list. */
  displayOrder: number;
}

function ageMs(updatedAt: string | null, now: number): number {
  if (!updatedAt) return Number.POSITIVE_INFINITY;
  const at = Date.parse(updatedAt);
  // An unparseable timestamp must not read as "just updated" — that would pin a
  // stuck row as permanently live and nothing would ever pick it up again.
  if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
  return now - at;
}

/** A `processing` row that nothing is driving any more. Safe to re-run. */
export function isStaleProcessing(
  status: string,
  updatedAt: string | null,
  now: number = Date.now()
): boolean {
  return status === 'processing' && ageMs(updatedAt, now) >= STALE_PROCESSING_MS;
}

/**
 * A `processing` row that was touched recently — almost certainly a server run
 * working on it this minute. Never re-run one of these: that is the only way
 * two workers can bill the same restaurant twice.
 */
export function isLiveProcessing(
  status: string,
  updatedAt: string | null,
  now: number = Date.now()
): boolean {
  return status === 'processing' && !isStaleProcessing(status, updatedAt, now);
}

/** Whether this restaurant is eligible for the given mode. */
export function isEligible(row: QueueRow, mode: QueueMode, now: number = Date.now()): boolean {
  if (mode === 'failed') {
    // Deliberately explicit, never automatic: re-running a restaurant that
    // genuinely has no menu spends full price on an outcome it cannot change.
    return row.status === 'no_menu' || row.status === 'error';
  }
  return row.status === 'pending' || isStaleProcessing(row.status, row.updatedAt, now);
}

/**
 * The restaurants a worker pass should analyse, in the guide's curated order so
 * the run walks the admin's list top to bottom and its progress is predictable.
 *
 * Idempotent by construction: it is derived entirely from current status, so
 * running it again after an interrupted pass picks up exactly what is left —
 * that is the whole resume mechanism.
 */
export function selectQueue(
  rows: QueueRow[],
  options: { mode?: QueueMode; limit?: number; now?: number } = {}
): QueueRow[] {
  const { mode = 'queued', limit, now = Date.now() } = options;
  const eligible = rows
    .filter((r) => isEligible(r, mode, now))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  // A limit of 0 means "none" — a real answer for a dry run, not "unlimited".
  return typeof limit === 'number' && limit >= 0 ? eligible.slice(0, limit) : eligible;
}

export interface QueueSummary {
  /** Waiting to be analysed, reclaimable stale rows included. */
  waiting: number;
  /** Being analysed right now by a live run. */
  running: number;
  /** Finished with a menu. */
  analysed: number;
  /** Finished with no menu or an error — re-runnable, but only on purpose. */
  failed: number;
  total: number;
}

/** Counts for the admin workspace, so one walk of the rows feeds every figure. */
export function queueSummary(rows: QueueRow[], now: number = Date.now()): QueueSummary {
  let waiting = 0;
  let running = 0;
  let analysed = 0;
  let failed = 0;
  for (const row of rows) {
    if (isLiveProcessing(row.status, row.updatedAt, now)) running++;
    else if (row.status === 'pending' || isStaleProcessing(row.status, row.updatedAt, now)) waiting++;
    else if (row.status === 'done') analysed++;
    else if (row.status === 'no_menu' || row.status === 'error') failed++;
  }
  return { waiting, running, analysed, failed, total: rows.length };
}

/** True while a server run appears to be working this guide. */
export function hasLiveRun(rows: QueueRow[], now: number = Date.now()): boolean {
  return rows.some((r) => isLiveProcessing(r.status, r.updatedAt, now));
}
