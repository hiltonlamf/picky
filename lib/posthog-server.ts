import { PostHog } from 'posthog-node';
import { hasServerAnalyticsConsent } from './telemetry';

export { hasServerAnalyticsConsent };

/** Just the bit of NextRequest we need, so this stays easy to call and test. */
type CookieReader = { cookies: { get(name: string): { value: string } | undefined } };

let _client: PostHog | null = null;

function client(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
      // Serverless: batching in memory loses events when the function
      // freezes, so send each event immediately.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

/**
 * Server-side event capture. Awaits the flush so the event leaves the
 * function before Vercel suspends it. Never throws — analytics must not
 * break the request it's riding on.
 *
 * Takes the `request` rather than a consent boolean **on purpose**: it makes
 * the consent check impossible to forget at a call site. The browser's
 * localStorage gate is invisible here, so before this existed, server events
 * were sent for people who had accepted nothing — confirmed on the PR #21
 * preview, where `analysis_completed` and `dish_reported` arrived from a
 * session that never touched the banner.
 *
 * This gates *PostHog only*. Operational records (parse_attempts, ai_usage_log)
 * are written by their own code paths and must keep running regardless — they're
 * how we run the service and account for its cost, not behavioural analytics.
 */
export async function captureServer(
  request: CookieReader,
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  if (!hasServerAnalyticsConsent(request)) return;
  const ph = client();
  if (!ph) return;
  try {
    ph.capture({ distinctId, event, properties });
    await ph.flush();
  } catch {
    // swallow — see above
  }
}

/**
 * Send a server exception to PostHog Error Tracking after analytics consent.
 * `captureExceptionImmediate` attaches the stack metadata PostHog needs and
 * waits for delivery, which is important in a serverless route.
 */
export async function captureServerException(
  request: CookieReader,
  distinctId: string,
  error: unknown,
  properties?: Record<string, unknown>
): Promise<void> {
  if (!hasServerAnalyticsConsent(request)) return;
  const ph = client();
  if (!ph) return;
  try {
    await ph.captureExceptionImmediate(error, distinctId, properties);
  } catch {
    // Error tracking must never break the request it is observing.
  }
}
