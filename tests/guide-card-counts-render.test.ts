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
    // The first bug: a non-wrapping row inside a card that clips its overflow
    // rendered "pescataria…" running off the screen edge.
    const row = html.match(/<div class="[^"]*flex-wrap[^"]*"/)?.[0] ?? '';
    expect(row).toContain('flex-wrap');
  });

  it('sizes each figure to its own text, so a wrapped line leaves no gap', () => {
    // The second bug: one pill AROUND all three cannot shrink to its wrapped
    // lines — CSS gives it the available width — so a short second line left a
    // wide empty space on the right. Each figure is its own chip instead.
    const chips = html.match(/<span class="[^"]*(?:picky-700|picky-600|ocean-700)[^"]*"/g) ?? [];
    expect(chips.length).toBe(3);
    for (const chip of chips) {
      // inline-flex hugs the text; whitespace-nowrap keeps a number with its
      // word, so wrapping only ever happens BETWEEN chips.
      expect(chip).toContain('inline-flex');
      expect(chip).toContain('whitespace-nowrap');
    }
    // And no shared wrapper draws a box around the group any more.
    const row = html.match(/<div class="[^"]*flex-wrap[^"]*"/)?.[0] ?? '';
    expect(row).not.toContain('glass-light');
  });
});
