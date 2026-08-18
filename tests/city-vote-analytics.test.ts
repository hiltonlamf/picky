import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CITY_VOTE_FUNNEL,
  EVENTS,
  cityVoteCtaClickedEvent,
  cityVoteStartedEvent,
  cityVoteSubmittedEvent,
} from '@/lib/analytics-events';

const serverPosthog = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = serverPosthog.capture;
    flush = serverPosthog.flush;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
});

describe('city vote analytics contract', () => {
  it('defines landing, selection, and one authoritative saved-vote step', () => {
    expect(CITY_VOTE_FUNNEL).toEqual([
      { step: 'landed', event: '$pageview', property: '$pathname', value: '/vote' },
      { step: 'selected_city', event: EVENTS.CITY_VOTE_STARTED },
      { step: 'vote_saved', event: EVENTS.CITY_VOTE_SUBMITTED, property: 'duplicate', value: false },
    ]);
  });

  it('keeps stable, useful properties without PII', () => {
    expect(cityVoteCtaClickedEvent('hero')).toEqual({
      event: 'city_vote_cta_clicked',
      properties: { placement: 'hero' },
    });
    expect(cityVoteStartedEvent({ city: 'Paris', region: 'Europe', custom: false })).toEqual({
      event: 'city_vote_started',
      properties: { city: 'Paris', region: 'Europe', custom: false },
    });
    const submitted = cityVoteSubmittedEvent({ city: 'Paris', region: 'Europe', custom: false, duplicate: false });
    expect(submitted).toEqual({
      event: 'city_vote_submitted',
      properties: { city: 'Paris', region: 'Europe', custom: false, duplicate: false },
    });
    expect(JSON.stringify(submitted.properties)).not.toMatch(/email|ip|anon/i);
  });

  it('emits submitted only from the server after the database accepts the vote', () => {
    const client = readFileSync('components/CityVoteForm.tsx', 'utf8');
    const server = readFileSync('app/api/city-votes/route.ts', 'utf8');
    expect(client).not.toContain('cityVoteSubmittedEvent');
    expect(server.match(/cityVoteSubmittedEvent/g)).toHaveLength(2); // import + call
  });
});

describe('city vote PostHog delivery', () => {
  const request = (consent?: string) => ({
    cookies: {
      get: (name: string) =>
        name === 'picky_analytics_consent' && consent ? { value: consent } : undefined,
    },
  });

  it('sends the authoritative saved-vote event once after consent', async () => {
    const { captureServer } = await import('@/lib/posthog-server');
    const analytics = cityVoteSubmittedEvent({
      city: 'Paris',
      region: 'Europe',
      custom: false,
      duplicate: false,
    });

    await captureServer(request('1'), 'anonymous-id', analytics.event, analytics.properties);

    expect(serverPosthog.capture).toHaveBeenCalledOnce();
    expect(serverPosthog.capture).toHaveBeenCalledWith({
      distinctId: 'anonymous-id',
      event: 'city_vote_submitted',
      properties: { city: 'Paris', region: 'Europe', custom: false, duplicate: false },
    });
    expect(serverPosthog.flush).toHaveBeenCalledOnce();
  });

  it('does not send behavioural vote events without consent', async () => {
    const { captureServer } = await import('@/lib/posthog-server');
    const analytics = cityVoteSubmittedEvent({
      city: 'Paris',
      region: 'Europe',
      custom: false,
      duplicate: false,
    });

    await captureServer(request(), 'anonymous-id', analytics.event, analytics.properties);
    expect(serverPosthog.capture).not.toHaveBeenCalled();
  });
});
