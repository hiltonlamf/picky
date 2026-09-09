import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CityGuide } from '@/types';

vi.mock('@/lib/posthog-client', () => ({ capture: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ captureError: vi.fn(), EVENTS: {} }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: unknown; href?: string }) =>
    createElement('a', { href }, children as never),
}));

import CityGuideSwitcher from '@/components/CityGuideSwitcher';

function guide(displayName: string): CityGuide {
  return {
    slug: displayName.toLowerCase(),
    displayName,
    country: 'Ireland',
    status: 'published',
    tagline: null,
    publishedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function render(props: Parameters<typeof CityGuideSwitcher>[0]): string {
  return renderToStaticMarkup(createElement(CityGuideSwitcher as never, props as never));
}

describe('CityGuideSwitcher', () => {
  it('stays the plain pill when there is nowhere else to go', () => {
    // A disclosure that opens onto an empty list is worse than no disclosure —
    // this is the state the site is in until a second guide is published.
    const html = render({
      currentSlug: 'dublin',
      where: 'Dublin, Ireland',
      guides: [guide('Dublin')],
    });

    expect(html).toContain('Dublin, Ireland');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
  });

  it('becomes a labelled disclosure once there is a second city', () => {
    const html = render({
      currentSlug: 'dublin',
      where: 'Dublin, Ireland',
      guides: [guide('Dublin'), guide('Cork')],
    });

    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    // The accessible name has to say what the button DOES, not just where you
    // are — "Dublin, Ireland" alone reads as a label, not a control.
    expect(html).toContain('change city');
  });

  it('keeps the panel closed until it is opened', () => {
    const html = render({
      currentSlug: 'dublin',
      where: 'Dublin, Ireland',
      guides: [guide('Dublin'), guide('Cork')],
    });

    // Cork is only inside the panel, which is not rendered while closed.
    expect(html).not.toContain('href="/cork"');
    expect(html).not.toContain('All city guides');
  });
});
