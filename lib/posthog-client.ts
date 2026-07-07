import posthog from 'posthog-js';
import { anonIdFromDocument } from './telemetry';

// Same key CookieConsent.tsx writes — analytics only ever starts after the
// user explicitly accepts the banner. No consent, no PostHog, no cookies.
const CONSENT_KEY = 'picky-cookie-consent';

let initialized = false;

export function hasAnalyticsConsent(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(CONSENT_KEY) === '1';
}

export function initPostHogIfConsented(): void {
  if (initialized || typeof window === 'undefined') return;
  if (!hasAnalyticsConsent()) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  // Use the middleware-set anon ID as the distinct_id so client events,
  // server events, and DB rows all join on the same per-browser identity.
  const anonId = anonIdFromDocument();
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
    persistence: 'localStorage+cookie',
    ...(anonId && { bootstrap: { distinctID: anonId } }),
  });
  initialized = true;
}

/** Capture a client-side event. Silently a no-op without consent/init. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}
