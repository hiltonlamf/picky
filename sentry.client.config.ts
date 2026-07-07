import * as Sentry from '@sentry/nextjs';

// Error monitoring only runs when a DSN is configured (production).
// No DSN (local dev without .env entry) → the SDK stays disabled.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // Never send user IPs or headers by default — errors only.
  sendDefaultPii: false,
});
