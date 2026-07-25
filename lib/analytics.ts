import * as Sentry from '@sentry/nextjs';
import { capture } from './posthog-client';

/**
 * Every analytics event name in one place.
 *
 * Event names are a schema: once a dashboard or funnel refers to one, a typo or
 * a rename silently breaks it and the chart just reads zero. Importing from
 * here means a rename is a compile error instead.
 */
export const EVENTS = {
  // --- core funnel ---
  SEARCH_SUBMITTED: 'search_submitted',
  MENU_CANDIDATES_SHOWN: 'menu_candidates_shown',
  MENUS_SELECTED: 'menus_selected',
  ANALYSIS_COMPLETED: 'analysis_completed',
  ANALYSIS_ABANDONED: 'analysis_abandoned',
  RESULTS_VIEWED: 'results_viewed',
  RESULTS_ENGAGED: 'results_engaged',
  NO_MENU_RESULT: 'no_menu_result',

  // --- city guides ---
  GUIDE_VIEWED: 'guide_viewed',
  GUIDE_RESTAURANT_CLICKED: 'guide_restaurant_clicked',

  // --- errors (see captureError) ---
  ERROR_SHOWN: 'error_shown',
  APP_CRASHED: 'app_crashed',
  RATE_LIMIT_HIT: 'rate_limit_hit',

  // --- feedback & sharing ---
  FEEDBACK_MODAL_OPENED: 'feedback_modal_opened',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  REPORT_MODAL_OPENED: 'report_modal_opened',
  DISH_REPORTED: 'dish_reported',
  SHARE_CLICKED: 'share_clicked',
  SHARE_LANDING: 'share_landing',
  NPS_SUBMITTED: 'nps_submitted',
  NPS_DISMISSED: 'nps_dismissed',

  // --- consent ---
  COOKIE_CONSENT_DECISION: 'cookie_consent_decision',
} as const;

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
  | 'server_error'
  | 'unknown';

/**
 * Codes worth waking Sentry for.
 *
 * Deliberately excludes the *expected* failures — a bad URL or a rate limit is
 * the system working as designed, and forwarding those burns Sentry quota (and
 * attention) for no diagnostic value. PostHog still counts every one of them.
 */
const SENTRY_WORTHY = new Set<ErrorCode>(['server_error', 'unknown', 'timeout', 'connection_dropped']);

const PATTERNS: Array<[RegExp, ErrorCode]> = [
  [/rate limit|too many requests|slow down/i, 'rate_limited'],
  [/connection dropped|no response body|stream closed/i, 'connection_dropped'],
  [/taking much longer|timed? ?out|took longer than expected/i, 'timeout'],
  [/invalid url|invalid request|enter a valid|must be a valid/i, 'invalid_url'],
  [/not found|doesn'?t exist|was removed/i, 'not_found'],
  [/couldn'?t read a menu|no menu|unreadable/i, 'no_menu_readable'],
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

/**
 * The single way a user-visible error gets reported.
 *
 * Every screen that shows someone an error calls this — so "how many people hit
 * an error today" is one number, not a hunt across seven components, and a
 * future silent `catch` stands out in review as the omission it is.
 *
 * Sends the countable event to PostHog always, and the stack trace to Sentry
 * only when the code is one we'd actually want to debug.
 */
export function captureError(params: {
  /** Which screen the person was on: 'search' | 'results' | 'submit_menu' | … */
  surface: string;
  message?: string | null;
  /** Override the classifier when the caller already knows the cause. */
  code?: ErrorCode;
  restaurantId?: string | null;
  extra?: Record<string, unknown>;
}): void {
  const { surface, message, restaurantId, extra } = params;
  const code = params.code ?? classifyError(message);

  capture(EVENTS.ERROR_SHOWN, {
    surface,
    error_code: code,
    // Kept for debugging, but never the thing we group or alert on.
    message: message ?? null,
    restaurant_id: restaurantId ?? null,
    ...extra,
  });

  if (SENTRY_WORTHY.has(code)) {
    Sentry.captureException(new Error(message || `${surface}: ${code}`), {
      tags: { surface, error_code: code },
      extra: { restaurant_id: restaurantId ?? null, ...extra },
    });
  }
}
