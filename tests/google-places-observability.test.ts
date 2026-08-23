import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  captureExceptionImmediate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = posthog.capture;
    flush = posthog.flush;
    captureExceptionImmediate = posthog.captureExceptionImmediate;
  },
}));

const request = (consent?: string) => ({
  cookies: {
    get: (name: string) =>
      name === 'picky_analytics_consent' && consent ? { value: consent } : undefined,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
});

describe('Google Places observability', () => {
  it('sends operational provider failures to Sentry and consented PostHog without search content', async () => {
    const { GooglePlacesError } = await import('@/lib/google-places');
    const { captureGooglePlacesFailure } = await import('@/lib/google-places-observability');
    const error = new GooglePlacesError('request_failed', 'Google Places autocomplete returned 403', {
      operation: 'autocomplete',
      status: 403,
      userMessage: 'Restaurant name search is temporarily unavailable.',
    });

    await captureGooglePlacesFailure({
      request: request('1'),
      distinctId: 'anonymous-id',
      operation: 'autocomplete',
      error,
      pickyCandidatesAvailable: true,
    });

    expect(sentry.captureException).toHaveBeenCalledWith(error, expect.objectContaining({
      tags: {
        area: 'restaurant_search',
        provider: 'google',
        provider_operation: 'autocomplete',
        provider_error_code: 'request_failed',
      },
      extra: {
        provider: 'google',
        operation: 'autocomplete',
        reason: 'request_failed',
        http_status: 403,
        picky_candidates_available: true,
      },
    }));
    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: 'anonymous-id',
      event: 'restaurant_search_provider_failed',
      properties: expect.objectContaining({ reason: 'request_failed', http_status: 403 }),
    });
    expect(posthog.captureExceptionImmediate).toHaveBeenCalledWith(
      error,
      'anonymous-id',
      expect.objectContaining({ provider: 'google', operation: 'autocomplete' })
    );

    const payload = JSON.stringify([sentry.captureException.mock.calls, posthog.capture.mock.calls]);
    expect(payload).not.toMatch(/query|place_?id|placeId/i);
  });

  it('keeps PostHog consent-gated while Sentry still records operational failures', async () => {
    const { GooglePlacesError } = await import('@/lib/google-places');
    const { captureGooglePlacesFailure } = await import('@/lib/google-places-observability');
    const error = new GooglePlacesError('unavailable', 'GOOGLE_PLACES_API_KEY is not configured', {
      operation: 'autocomplete',
    });

    await captureGooglePlacesFailure({
      request: request(),
      distinctId: 'anonymous-id',
      operation: 'autocomplete',
      error,
    });

    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it('counts expected lookup outcomes without creating error issues', async () => {
    const { trackGooglePlacesIssue } = await import('@/lib/google-places-observability');

    await trackGooglePlacesIssue({
      request: request('1'),
      distinctId: 'anonymous-id',
      operation: 'details',
      reason: 'missing_website',
    });

    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: 'anonymous-id',
      event: 'restaurant_search_provider_failed',
      properties: {
        provider: 'google',
        operation: 'details',
        reason: 'missing_website',
        http_status: null,
        picky_candidates_available: false,
      },
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(posthog.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it('counts a stale Google place without opening a Sentry or PostHog error issue', async () => {
    const { GooglePlacesError } = await import('@/lib/google-places');
    const { captureGooglePlacesFailure } = await import('@/lib/google-places-observability');
    const error = new GooglePlacesError('not_found', 'Google Place Details returned 404', {
      operation: 'details',
      status: 404,
      userMessage: 'That restaurant is no longer available. Try another result.',
    });

    await captureGooglePlacesFailure({
      request: request('1'),
      distinctId: 'anonymous-id',
      operation: 'details',
      error,
    });

    expect(posthog.capture).toHaveBeenCalledWith({
      distinctId: 'anonymous-id',
      event: 'restaurant_search_provider_failed',
      properties: expect.objectContaining({ reason: 'not_found', http_status: 404 }),
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(posthog.captureExceptionImmediate).not.toHaveBeenCalled();
  });
});
