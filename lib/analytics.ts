import * as Sentry from '@sentry/nextjs';
import { capture } from './posthog-client';
import { classifyError, type ErrorCode } from './telemetry';

export { classifyError };
export type { ErrorCode };

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

  // --- transparency ---
  // Fires once per visit when someone opens "How we count veggie dishes".
  // If nobody opens it, the note is decoration and the split belongs on the
  // card itself; if lots do, the number isn't explaining itself.
  COUNTING_METHOD_EXPANDED: 'counting_method_expanded',

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
 * Codes worth waking Sentry for.
 *
 * Deliberately excludes the *expected* failures — a bad URL or a rate limit is
 * the system working as designed, and forwarding those burns Sentry quota (and
 * attention) for no diagnostic value. PostHog still counts every one of them.
 */
const SENTRY_WORTHY = new Set<ErrorCode>(['server_error', 'unknown', 'timeout', 'connection_dropped']);

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
