import * as Sentry from '@sentry/nextjs';
import { capture } from './posthog-client';
import { classifyError, type ErrorCode } from './telemetry';
import { EVENTS } from './analytics-events';

export { classifyError };
export type { ErrorCode };
export { EVENTS } from './analytics-events';

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
