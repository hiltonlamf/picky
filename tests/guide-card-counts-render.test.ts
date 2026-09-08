import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Restaurant, MenuSection, Dish, DietaryClassification } from '@/types';

// Browser-only deps, stubbed so the card can be rendered as markup. vi.mock is
// hoisted above the imports below.
vi.mock('@/lib/posthog-client', () => ({ capture: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ captureError: vi.fn(), EVENTS: {} }));
vi.mock('next/link', () => ({
  default: ({ children }: { children?: unknown }) => createElement('a', null, children as never),
}));
vi.mock('@/components/FeedbackModal', () => ({ default: () => null }));

import RestaurantCard from '@/components/RestaurantCard';

let id = 0;
function dish(name: string, classification: DietaryClassification, price = '€20.00'): Dish {
  return {
    id: `d${id++}`, name, description: null, price, classification,
    confidence: 0.9, reportCount: 0, warningFlagged: false, humanVerified: false, origin: 'ai',
  };
}
function section(name: string, dishes: Dish[]): MenuSection {
  return { id: `s${id++}`, name, displayOrder: 0, dishes, menuLabel: null };
}
function restaurant(sections: MenuSection[]): Restaurant {
  return {
    id: 'r1', url: 'https://example.com', name: 'Baan Thai Ballsbridge',
    status: 'done', sections, createdAt: '', updatedAt: '',
  } as unknown as Restaurant;
}

// A restaurant with all three figures — the case that overflowed on a phone.
const html = renderToStaticMarkup(
  createElement(RestaurantCard as never, {
    restaurant: restaurant([
      section('Mains', [
        ...Array.from({ length: 5 }, (_, i) => dish(`Vegan Main ${i}`, 'vegan')),
        ...Array.from({ length: 18 }, (_, i) => dish(`Veggie Main ${i}`, 'vegetarian')),
        ...Array.from({ length: 7 }, (_, i) => dish(`Prawn Main ${i}`, 'neither')),
      ]),
    ]),
  } as never)
);

describe('the guide card count pill', () => {
  it('shows all three figures', () => {
    expect(html).toContain('vegan');
    expect(html).toContain('veggie');
    expect(html).toContain('pescatarian');
  });

  it('wraps instead of overflowing — three figures are wider than a phone', () => {
    // The bug: a non-wrapping row inside a card that clips its overflow
    // rendered "pescataria…" running off the screen edge.
    const pill = html.match(/<div class="[^"]*glass-light[^"]*"/)?.[0] ?? '';
    expect(pill).toContain('flex-wrap');
    expect(pill).toContain('max-w-full');
    expect(pill).not.toContain('overflow-hidden');
  });

  it('keeps each figure whole when the group wraps', () => {
    // Wrapping must happen BETWEEN figures, never inside one, or a number
    // ends up on a different line from the word it belongs to.
    const figures = html.match(/<span class="[^"]*(?:picky-700|picky-600|ocean-700)[^"]*"/g) ?? [];
    expect(figures.length).toBe(3);
    for (const f of figures) expect(f).toContain('whitespace-nowrap');
  });
});
