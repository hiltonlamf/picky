'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Root error boundary — catches React rendering crashes that would
 * otherwise white-screen the app, and reports them to Sentry.
 * Must render its own <html>/<body> because it replaces the root layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem 1.5rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
        <p style={{ color: '#555', marginBottom: '1.5rem' }}>
          Sorry — that shouldn&apos;t have happened. It&apos;s been reported automatically.
        </p>
        <button
          onClick={reset}
          style={{
            padding: '0.6rem 1.4rem',
            borderRadius: '9999px',
            border: 'none',
            background: '#16a34a',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
