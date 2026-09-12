import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GUIDE_FILTER_THRESHOLD } from '@/lib/city-guides';
import type { CityGuide } from '@/types';

// Browser-only deps, stubbed so the list can be rendered as markup.
// vi.mock is hoisted above the imports below.
vi.mock('@/lib/posthog-client', () => ({ capture: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ captureError: vi.fn(), EVENTS: {} }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: unknown; href?: string }) =>
    createElement('a', { href }, children as never),
}));

import CityGuideList, { type CityGuideListItem } from '@/components/CityGuideList';

function guide(
  displayName: string,
  country: string | null,
  extra: Partial<CityGuideListItem> = {}
): CityGuideListItem {
  return {
    slug: displayName.toLowerCase().replace(/\s+/g, '-'),
    displayName,
    country,
    status: 'published',
    tagline: null,
    publishedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  } as CityGuideListItem;
}

function render(props: Parameters<typeof CityGuideList>[0]): string {
  return renderToStaticMarkup(createElement(CityGuideList as never, props as never));
}

const THREE_IRISH_CITIES: CityGuideListItem[] = [
  guide('Dublin', 'Ireland', { }),
  guide('Cork', 'Ireland', { }),
  guide('Limerick', 'Ireland', { }),
];

describe('CityGuideList — hub', () => {
  const html = render({ guides: THREE_IRISH_CITIES, variant: 'hub' });

  it('groups the cities under one country heading', () => {
    expect(html).toContain('Ireland');
    expect(html).toContain('🇮🇪');
    // One heading, not one per city.
    expect(html.match(/aria-label="Ireland"/g)).toHaveLength(1);
  });

  it('links each city at its own slug', () => {
    for (const slug of ['/dublin', '/cork', '/limerick']) {
      expect(html).toContain(`href="${slug}"`);
    }
  });

  it('shows no restaurant count on a card, on purpose', () => {
    // The count was removed (founder, 2026-09-12): it is not how anyone picks a
    // city, and the one we showed was wrong — the query behind it was silently
    // truncated by PostgREST's 1000-row cap, so Cork read "1 restaurant" and
    // Limerick "Nothing live yet" while both had plenty live. A number a
    // visitor can disprove by clicking through is worse than no number.
    expect(html).not.toMatch(/\d+ restaurants?/);
    expect(html).not.toContain('Nothing live yet');
  });

  it('shows no filter box for a handful of cities', () => {
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('role="search"');
  });

  it('grows a filter box once the list is genuinely long', () => {
    const many = Array.from({ length: GUIDE_FILTER_THRESHOLD + 1 }, (_, i) =>
      guide(`City ${i}`, 'Ireland', { })
    );
    const longHtml = render({ guides: many, variant: 'hub' });
    expect(longHtml).toContain('type="search"');
    expect(longHtml).toContain('role="search"');
  });

  it('hides draft guides behind the admin flag', () => {
    const withDraft = [...THREE_IRISH_CITIES, guide('Galway', 'Ireland', { status: 'draft' })];
    expect(render({ guides: withDraft, variant: 'hub' })).not.toContain('only you can see');
    expect(render({ guides: withDraft, variant: 'hub', showDraftBadge: true })).toContain(
      'only you can see'
    );
  });

  it('reports when nothing matches rather than rendering an empty page', () => {
    expect(render({ guides: [], variant: 'hub' })).toContain('No city matches that');
  });
});

describe('CityGuideList — switcher', () => {
  const html = render({
    guides: THREE_IRISH_CITIES,
    variant: 'switcher',
    currentSlug: 'dublin',
  });

  it('keeps the current city in the list, marked in place', () => {
    expect(html).toContain('Dublin');
    expect(html).toContain('aria-current="page"');
    // Marked with visible text, not a hover-only title — hover does not exist
    // on a touch device.
    expect(html).toContain('You are here');
    expect(html).not.toContain('title="You are here"');
  });

  it('does not link the current city to itself', () => {
    expect(html).not.toContain('href="/dublin"');
    expect(html).toContain('href="/cork"');
    expect(html).toContain('href="/limerick"');
  });

  it('does not show restaurant counts — the switcher is navigation, not a pitch', () => {
    expect(html).not.toContain('18 restaurants');
  });
});
