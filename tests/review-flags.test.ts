import { describe, it, expect } from 'vitest';
import { computeReviewFlags, isPubliclyVisible, MIN_GUIDE_DISHES } from '@/lib/review-flags';
import type { Restaurant, Dish } from '@/types';

function dish(name: string, description?: string): Dish {
  return {
    id: Math.random().toString(36).slice(2),
    name,
    description: description ?? null,
    price: null,
    classification: 'vegetarian',
    confidence: 0.9,
    reportCount: 0,
    warningFlagged: false,
    humanVerified: false,
    origin: 'ai',
  };
}

function restaurant(dishes: Dish[], over: Partial<Restaurant> = {}): Restaurant {
  return {
    id: 'r1',
    url: 'https://example.com',
    city: 'dublin',
    status: 'done',
    sections: [{ id: 's1', name: 'Menu', displayOrder: 0, dishes }],
    createdAt: '2026-07-19',
    ...over,
  };
}

const manyDishes = Array.from({ length: 10 }, (_, i) => dish(`Dish ${i}`));

describe('computeReviewFlags', () => {
  it('flags a thin menu', () => {
    const flags = computeReviewFlags(restaurant([dish('Soup'), dish('Salad')]));
    expect(flags.some((f) => f.code === 'few_dishes')).toBe(true);
  });

  it('flags a tasting menu captured as a single dish', () => {
    const flags = computeReviewFlags(restaurant([dish('Seven Course Tasting Menu', '€95 per person')].concat(manyDishes)));
    expect(flags.some((f) => f.code === 'menu_as_dish')).toBe(true);
  });

  it('flags a dish whose name is really a menu title', () => {
    const flags = computeReviewFlags(restaurant([dish('Dim Sum Menu')].concat(manyDishes)));
    expect(flags.some((f) => f.code === 'menu_as_dish')).toBe(true);
  });

  it('does not flag a normal well-populated menu', () => {
    expect(computeReviewFlags(restaurant(manyDishes))).toHaveLength(0);
  });

  it('does not flag an ordinary dish with a normal description', () => {
    const normal = dish('Roast cauliflower', 'Charred cauliflower, tahini, pomegranate, dukkah. €14');
    expect(computeReviewFlags(restaurant([normal].concat(manyDishes)))).toHaveLength(0);
  });
});

describe('isPubliclyVisible', () => {
  it('hides non-done restaurants', () => {
    expect(isPubliclyVisible(restaurant(manyDishes, { status: 'error' }))).toBe(false);
  });

  it('hides restaurants under the dish threshold', () => {
    expect(isPubliclyVisible(restaurant(manyDishes.slice(0, MIN_GUIDE_DISHES - 1)))).toBe(false);
  });

  it('shows a clean, well-populated restaurant', () => {
    expect(isPubliclyVisible(restaurant(manyDishes))).toBe(true);
  });

  it('hides a flagged restaurant until approved, then shows it', () => {
    const flagged = restaurant([dish('Tasting Menu', '5 courses, €90 per person')].concat(manyDishes));
    expect(isPubliclyVisible(flagged)).toBe(false);
    expect(isPubliclyVisible({ ...flagged, guideApprovedAt: '2026-07-19T00:00:00Z' })).toBe(true);
  });
});
