import type { MenuCandidate } from '@/types';

/**
 * Per-browser anonymous usage ID (UUID, set by middleware.ts, 1-year expiry).
 * A stable persistent ID for usage-per-person measurement — deliberately NOT
 * the per-request IP hash in lib/rate-limit.ts, which exists for abuse
 * control. Monetization groundwork: usage can't be reconstructed later.
 * Not httpOnly — the PostHog client reads it as its distinct_id.
 */
export const ANON_ID_COOKIE = 'picky_anon_id';

/**
 * Mirrors the browser's analytics consent so *server* code can see it.
 *
 * The client-side consent gate can't reach API routes: server events are sent
 * by posthog-node inside the route handler, with no access to localStorage. So
 * `analysis_completed` and `dish_reported` were reaching PostHog for visitors
 * who had never accepted anything (confirmed on the PR #21 preview).
 *
 * Written by grantConsent()/denyConsent(), read by captureServer(). Not
 * httpOnly, because the client is what sets it.
 *
 * Note the deliberate limit of what this gates: **only third-party analytics.**
 * Our own operational records — parse_attempts, ai_usage_log, feedback — carry
 * on regardless. Those are how the service is run and how its costs are
 * accounted for, not behavioural tracking, and losing them would leave us
 * unable to tell whether the product works or what it costs.
 */
export const ANALYTICS_CONSENT_COOKIE = 'picky_analytics_consent';

/** Just the bit of NextRequest we need, so this stays easy to call and test. */
type CookieReader = { cookies: { get(name: string): { value: string } | undefined } };

/**
 * Whether this visitor agreed to analytics, from the cookie the browser sets.
 *
 * Lives here rather than beside captureServer deliberately: it's pure cookie
 * logic with no dependency on posthog-node, and keeping it separate means
 * testing it doesn't drag the whole SDK into the test run.
 *
 * Fails closed — no cookie means no consent.
 */
export function hasServerAnalyticsConsent(request: CookieReader): boolean {
  return request.cookies.get(ANALYTICS_CONSENT_COOKIE)?.value === '1';
}

/** localStorage key: timestamp (ms) of this browser's first successful
 *  analysis — the anchor for the day-7+ NPS prompt. */
export const FIRST_ANALYSIS_KEY = 'picky-first-analysis-at';

/** localStorage key: set once the NPS prompt was answered or dismissed. */
export const NPS_DONE_KEY = 'picky-nps-done';

/** Read the anon ID from document.cookie (client-side only; null on server). */
export function anonIdFromDocument(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${ANON_ID_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Bucket a set of menu candidates into the analytics category taxonomy:
 * pdf / image / js / text / multi. "js" covers menus that live on a
 * separate page the scraper had to follow (usually JS-rendered sites).
 */
export function menuCategory(candidates: Array<Pick<MenuCandidate, 'type'>>): string {
  if (candidates.length > 1) return 'multi';
  switch (candidates[0]?.type) {
    case 'pdf':
      return 'pdf';
    case 'image':
      return 'image';
    case 'subpage':
      return 'js';
    default:
      return 'text';
  }
}

/** Bare hostname of a URL ("www." stripped), or null if unparseable. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
