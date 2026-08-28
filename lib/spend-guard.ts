import * as Sentry from '@sentry/nextjs';
import { aiSpendSince } from './db';

/**
 * Global daily ceiling on paid AI work.
 *
 * The per-IP hourly cap in ./rate-limit bounds one visitor. Nothing bounded
 * *everyone*, so a busy day — or one determined person — could run up an
 * unbounded Anthropic bill on a personally-funded account with no signal until
 * the balance moved. This is the backstop.
 *
 * Scope is deliberately narrow: it stops only NEW paid analyses. Cached
 * restaurants, the city guides and every already-analysed page read from the
 * database and keep working, so a visitor still sees a working product rather
 * than a broken one.
 */

export const DAILY_SPEND_CAP_USD = Number(process.env.DAILY_SPEND_CAP_USD || '25');

/** Shown to the user when the cap is hit. Deliberately not alarming. */
export const AT_CAPACITY_MESSAGE =
  "We're at capacity for today — this one's on us to fix. Please try again tomorrow, " +
  'or browse the Dublin guide in the meantime.';

type CachedSpend = { total: number; at: number };
let cache: CachedSpend | null = null;

// The guard sits on the request path, so it must not add a DB round trip per
// request. 60s is short enough that a spike is caught within a couple of
// analyses (each costs cents, so the worst-case overshoot is small) and long
// enough that a burst of traffic doesn't hammer Postgres.
const CACHE_TTL_MS = 60_000;

/** Test seam — clears the memo so a test can control the window. */
export function resetSpendCache(): void {
  cache = null;
}

export type SpendCheck = {
  allowed: boolean;
  spentUsd: number;
  capUsd: number;
};

/**
 * Whether new paid analysis may start.
 *
 * FAILS CLOSED on a read error. The whole point of this guard is that we cannot
 * see the bill in real time; "we don't know what we've spent" is precisely when
 * we should not start spending more.
 */
export async function checkDailySpend(): Promise<SpendCheck> {
  const capUsd = DAILY_SPEND_CAP_USD;

  // A cap of 0 or a non-numeric env value would otherwise silently block every
  // analysis. Treat it as "not configured" and let requests through — the
  // per-IP cap still applies.
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { allowed: true, spentUsd: 0, capUsd: 0 };
  }

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { allowed: cache.total < capUsd, spentUsd: cache.total, capUsd };
  }

  let total: number;
  try {
    total = await aiSpendSince(new Date(now - 24 * 60 * 60 * 1000));
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'spend_guard' } });
    return { allowed: false, spentUsd: 0, capUsd };
  }

  cache = { total, at: now };

  if (total >= capUsd) {
    // Loud on purpose: this should reach a dashboard, not a credit balance.
    Sentry.captureMessage(
      `Daily AI spend cap reached: $${total.toFixed(2)} of $${capUsd.toFixed(2)}`,
      { level: 'warning', tags: { surface: 'spend_guard' } }
    );
  }

  return { allowed: total < capUsd, spentUsd: total, capUsd };
}
