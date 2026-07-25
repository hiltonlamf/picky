'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import Link from 'next/link';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';

/**
 * Route-level error boundary. Previously only the root boundary in
 * global-error.tsx existed, so any crash inside a page tore down the whole
 * layout — header, footer and all — and looked far more broken than it was.
 * This keeps the chrome and lets the person carry on.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    // Also counted in PostHog so crashes show up in the funnel next to every
    // other reason people drop off, rather than only in a separate tool.
    capture(EVENTS.APP_CRASHED, {
      message: error.message,
      digest: error.digest ?? null,
      path: typeof window !== 'undefined' ? window.location.pathname : null,
    });
  }, [error]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-16 text-center">
      <h1 className="font-display text-2xl text-forest mb-2">Something went wrong</h1>
      <p className="text-forest/80 mb-6">
        Sorry — that shouldn&apos;t have happened. It&apos;s been reported automatically.
      </p>
      <div className="flex gap-3 justify-center">
        <button onClick={reset} className="btn-cta">
          Try again
        </button>
        <Link href="/" className="btn-ghost inline-block">
          ← Back to search
        </Link>
      </div>
    </div>
  );
}
