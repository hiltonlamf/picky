import * as Sentry from '@sentry/nextjs';
import { anonIdFromDocument } from './lib/telemetry';

// Error monitoring only runs when a DSN is configured (production).
// No DSN (local dev without .env entry) → the SDK stays disabled.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Never send user IPs or headers by default — errors only.
  sendDefaultPii: false,
});

// Tag errors with the same anonymous ID PostHog uses as its distinct_id, so a
// spike on the error dashboard leads directly to the exact stack trace here and
// to the session replay of the person who hit it. It's the random per-browser
// UUID from middleware, not anything identifying — so this adds no PII.
const anonId = anonIdFromDocument();
if (anonId) Sentry.setUser({ id: anonId });
