import * as Sentry from '@sentry/nextjs';
import { EVENTS } from './analytics-events';
import { GooglePlacesError, type GooglePlacesOperation } from './google-places';
import { captureServer, captureServerException } from './posthog-server';

type CookieReader = { cookies: { get(name: string): { value: string } | undefined } };

type GooglePlacesExpectedIssue = 'rate_limited' | 'closed_permanently' | 'missing_website';

interface ProviderContext {
  request: CookieReader;
  distinctId: string;
  operation: GooglePlacesOperation;
  pickyCandidatesAvailable?: boolean;
}

function properties(input: ProviderContext, reason: string, status: number | null) {
  return {
    provider: 'google',
    operation: input.operation,
    reason,
    http_status: status,
    picky_candidates_available: input.pickyCandidatesAvailable ?? false,
  };
}

/**
 * Capture an actual Google provider failure in both operational systems.
 * Deliberately accepts no restaurant query or place ID, so those values cannot
 * accidentally reach Sentry, PostHog, or session replay through this path.
 */
export async function captureGooglePlacesFailure(input: ProviderContext & { error: unknown }): Promise<void> {
  const providerError = input.error instanceof GooglePlacesError ? input.error : null;
  const operation = providerError?.operation ?? input.operation;
  const reason = providerError?.code ?? 'unexpected';
  const status = providerError?.status ?? null;
  const error = input.error instanceof Error ? input.error : new Error('Google Places request failed');
  const context = { ...input, operation };
  const safeProperties = properties(context, reason, status);

  // A stale/deleted place ID is an expected lookup outcome. Count it in
  // PostHog, but do not create a Sentry issue or PostHog exception for it.
  const operationalFailure = reason !== 'not_found';
  if (operationalFailure) {
    Sentry.captureException(error, {
      tags: {
        area: 'restaurant_search',
        provider: 'google',
        provider_operation: operation,
        provider_error_code: reason,
      },
      extra: safeProperties,
      level: 'error',
    });
  }

  await captureServer(
    input.request,
    input.distinctId,
    EVENTS.RESTAURANT_SEARCH_PROVIDER_FAILED,
    safeProperties
  );
  if (operationalFailure) {
    await captureServerException(input.request, input.distinctId, error, safeProperties);
  }
}

/** Count expected, actionable lookup outcomes without creating error issues. */
export async function trackGooglePlacesIssue(
  input: ProviderContext & { reason: GooglePlacesExpectedIssue }
): Promise<void> {
  await captureServer(
    input.request,
    input.distinctId,
    EVENTS.RESTAURANT_SEARCH_PROVIDER_FAILED,
    properties(input, input.reason, null)
  );
}
