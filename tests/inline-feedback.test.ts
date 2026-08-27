import { describe, it, expect } from 'vitest';
import { EVENTS } from '@/lib/analytics-events';
import { INLINE_FEEDBACK_TYPES } from '@/lib/dietary-config';
import { readFileSync } from 'node:fs';

const component = readFileSync('components/InlineFeedbackNote.tsx', 'utf8');
const inbox = readFileSync('app/admin/feedback/FeedbackInboxClient.tsx', 'utf8');
const results = readFileSync('components/RestaurantPage.tsx', 'utf8');

describe('inline feedback capture', () => {
  it('every surface it can post has a label in the admin inbox', () => {
    // A note that lands as a raw slug in the inbox is a note nobody reads.
    const posted = [...component.matchAll(/'(\w+_note)'/g)].map((m) => m[1]);
    expect(posted.length).toBeGreaterThan(0);
    const labelled = new Set(INLINE_FEEDBACK_TYPES.map((t) => t.value));
    for (const type of posted) expect(labelled.has(type), type).toBe(true);
    expect(inbox).toContain('INLINE_FEEDBACK_TYPES');
  });

  it('posts to the existing feedback endpoint rather than a new one', () => {
    expect(component).toContain("'/api/feedback'");
  });

  it('names its events in the EVENTS schema', () => {
    expect(EVENTS.INLINE_FEEDBACK_OPENED).toBe('inline_feedback_opened');
    expect(EVENTS.INLINE_FEEDBACK_SUBMITTED).toBe('inline_feedback_submitted');
    expect(component).toContain('EVENTS.INLINE_FEEDBACK_SUBMITTED');
  });
});

describe('results-page filter events', () => {
  // These were raw literals; 'filter_changed' matched a dashboard only by
  // coincidence and a rename on either side would have silently zeroed it.
  it('fire through the EVENTS schema, not string literals', () => {
    expect(results).not.toMatch(/capture\('(menu_)?filter_changed'/);
    expect(results).toContain('EVENTS.FILTER_CHANGED');
    expect(results).toContain('EVENTS.MENU_FILTER_CHANGED');
  });
});

describe('posthog dashboards', () => {
  const dashboards = readFileSync('scripts/posthog/dashboards.ts', 'utf8');

  it('cover the city-vote funnel the launch drives traffic to', () => {
    for (const ev of ['city_vote_cta_clicked', 'city_vote_started', 'city_vote_submitted']) {
      expect(dashboards, ev).toContain(ev);
    }
  });

  it('cover the events that fired but had no chart', () => {
    for (const ev of ['restaurant_search_no_results', 'guide_filter_changed', 'inline_feedback_submitted']) {
      expect(dashboards, ev).toContain(ev);
    }
  });
});
