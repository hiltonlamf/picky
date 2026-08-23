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

/**
 * Stable error codes.
 *
 * Raw error messages are useless for grouping — one wording change and PostHog
 * shows two unrelated-looking problems, and a chart broken down by message is a
 * list of fifty one-offs instead of five real issues. The message is still kept
 * as a property for debugging; the code is what we count.
 */
export type ErrorCode =
  | 'timeout'
  | 'connection_dropped'
  | 'invalid_url'
  | 'rate_limited'
  | 'site_unreachable'
  | 'no_menu_readable'
  | 'not_found'
  | 'network'
  | 'provider_unavailable'
  | 'server_error'
  | 'unknown';

const PATTERNS: Array<[RegExp, ErrorCode]> = [
  [/rate limit|too many requests|slow down/i, 'rate_limited'],
  [/connection dropped|no response body|stream closed/i, 'connection_dropped'],
  [/taking much longer|timed? ?out|took longer than expected/i, 'timeout'],
  [/invalid url|invalid request|enter a valid|must be a valid/i, 'invalid_url'],
  [/restaurant (?:name search|lookup) is temporarily unavailable/i, 'provider_unavailable'],
  // Apostrophes are matched as a class: the app's user-facing copy uses curly
  // ’ (U+2019), so a pattern written with a straight ' silently never matches
  // and the error lands in 'unknown'. Caught by tests/analytics.test.ts, which
  // asserts against the real strings rather than retyped approximations.
  [/not found|does ?n['’]?o?t exist|was removed|permanently closed|could ?n['’]?o?t find an official website/i, 'not_found'],
  // Widened after a real run classified as 'unknown': the live copy says
  // "couldn't READ A FOOD menu" and "couldn't FIND A food menu", neither of
  // which matched "read a menu". A failure_reason of 'unknown' makes the whole
  // health dashboard breakdown useless, so these patterns are asserted against
  // the actual strings in tests/analytics.test.ts.
  [/could ?n['’]?o?t (read|find) a [\w ]*menu|no menu|unreadable|not publish one/i, 'no_menu_readable'],
  [/down or not live|looks like it'?s down/i, 'site_unreachable'],
  [/failed to fetch|network ?error|load failed|econnrefused|enotfound/i, 'network'],
  [/unreachable|refused|dns|certificate|ssl|tls/i, 'site_unreachable'],
  [/^(internal )?server error|^5\d\d\b/i, 'server_error'],
];

/** Map a raw error message to a stable code. Order matters — first match wins. */
export function classifyError(message: string | null | undefined): ErrorCode {
  if (!message) return 'unknown';
  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'unknown';
}
