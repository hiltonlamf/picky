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

  /**
   * The failure this flag exists for: the parse collapsed a whole menu into one
   * row, so the suspect dish is nearly all we found.
   */
  it('flags a tasting menu captured as a single dish', () => {
    const flags = computeReviewFlags(
      restaurant([dish('Seven Course Tasting Menu', '€95 per person'), dish('Soup'), dish('Bread')])
    );
    expect(flags.some((f) => f.code === 'menu_as_dish')).toBe(true);
  });

  it('flags a dish whose name is really a menu title', () => {
    const flags = computeReviewFlags(restaurant([dish('Dim Sum Menu'), dish('Soup'), dish('Bread')]));
    expect(flags.some((f) => f.code === 'menu_as_dish')).toBe(true);
  });

  /**
   * ...but the same row inside a properly-read menu is just a dish the
   * restaurant sells. Pickle lists a €95 "Tasting Menu — curated by Chef Sunil,
   * on request" among 44 à la carte dishes, and Hot Stone an "A5 Kobe Tasting
   * Menu" among 56. Both were withheld from the live guide for correctly
   * reading a real item — a parse that found 44 dishes plainly did not collapse
   * a menu into one row.
   */
  it('does NOT flag a tasting-menu row inside a well-populated menu (Pickle, Hot Stone)', () => {
    const flags = computeReviewFlags(
      restaurant([dish('Tasting Menu', 'Curated by the chef, on request. €95 per person')].concat(manyDishes))
    );
    expect(flags.some((f) => f.code === 'menu_as_dish')).toBe(false);
  });

  it('judges by the dish\'s OWN menu, not the restaurant total', () => {
    // 10 healthy dishes on "À la carte" do not vouch for a "Tasting" menu that
    // is nothing but its own title.
    const r = restaurant([], {
      sections: [
        { id: 'a', name: 'Mains', displayOrder: 0, menuLabel: 'À la carte', dishes: manyDishes },
        { id: 'b', name: 'Tasting', displayOrder: 1, menuLabel: 'Tasting', dishes: [dish('Tasting Menu')] },
      ],
    });
    expect(computeReviewFlags(r).some((f) => f.code === 'menu_as_dish')).toBe(true);
  });

  it('does not flag a normal well-populated menu', () => {
    expect(computeReviewFlags(restaurant(manyDishes))).toHaveLength(0);
  });

  it('does not flag an ordinary dish with a normal description', () => {
    const normal = dish('Roast cauliflower', 'Charred cauliflower, tahini, pomegranate, dukkah. €14');
    expect(computeReviewFlags(restaurant([normal].concat(manyDishes)))).toHaveLength(0);
  });
});

/**
 * MIN_GUIDE_DISHES is a per-RESTAURANT total, so a restaurant can clear it
 * while carrying a broken menu inside it. Found live in production:
 * Chapter One (13 dishes) had a "Dinner Menu" of 2, and Featherblade a whole
 * menu called "Burgers" holding only "The Best Burger in Dublin".
 */
describe('per-menu thin tripwire', () => {
  const labelled = (menus: Array<{ label: string; count: number }>): Restaurant =>
    restaurant([], {
      sections: menus.map((m, i) => ({
        id: `s${i}`,
        name: 'Mains',
        displayOrder: i,
        menuLabel: m.label,
        dishes: Array.from({ length: m.count }, (_, j) => dish(`${m.label} dish ${j}`)),
      })),
    });

  it('flags a restaurant whose individual menu is too thin (Chapter One)', () => {
    const flags = computeReviewFlags(
      labelled([{ label: 'Lunch Menu', count: 5 }, { label: 'Dinner Menu', count: 2 }, { label: 'Tasting Menu', count: 6 }])
    );
    expect(flags.some((f) => f.code === 'thin_menu')).toBe(true);
    expect(flags.find((f) => f.code === 'thin_menu')?.label).toContain('Dinner Menu');
  });

  it('flags a one-dish menu even when the restaurant total is healthy (Featherblade)', () => {
    const flags = computeReviewFlags(labelled([{ label: 'Menu', count: 20 }, { label: 'Burgers', count: 1 }]));
    expect(flags.some((f) => f.code === 'thin_menu')).toBe(true);
  });

  it('withholds such a restaurant from the public guide', () => {
    expect(isPubliclyVisible(labelled([{ label: 'Menu', count: 20 }, { label: 'Burgers', count: 1 }]))).toBe(false);
  });

  /**
   * The false positive that an earlier version of this rule produced: it would
   * have pulled Pickle (4 desserts) and Drury Buildings (3) off the live guide
   * for having a perfectly normal dessert menu.
   */
  it.each(['Dessert Menu', 'Desserts', 'Sides', 'Sauces', 'Cheese'])(
    'does NOT flag a short "%s" — those are honestly short',
    (label) => {
      const flags = computeReviewFlags(labelled([{ label: 'Main Menu', count: 40 }, { label, count: 3 }]));
      expect(flags.some((f) => f.code === 'thin_menu')).toBe(false);
    }
  );

  it('does not flag an untagged single menu (already covered by MIN_GUIDE_DISHES)', () => {
    const flags = computeReviewFlags(restaurant(manyDishes));
    expect(flags.some((f) => f.code === 'thin_menu')).toBe(false);
  });

  it('does not flag menus that are all healthy', () => {
    const flags = computeReviewFlags(labelled([{ label: 'Lunch', count: 12 }, { label: 'Dinner', count: 20 }]));
    expect(flags).toHaveLength(0);
  });
});

/**
 * Founder's call (2026-08-18): duplicate menus are ALWAYS flagged for a human,
 * never removed automatically.
 */
describe('duplicate menus are flagged, never deleted', () => {
  const menus = (spec: Array<{ label: string; dishes: string[] }>): Restaurant =>
    restaurant([], {
      sections: spec.map((m, i) => ({
        id: `s${i}`,
        name: 'Mains',
        displayOrder: i,
        menuLabel: m.label,
        dishes: m.dishes.map((n) => dish(n)),
      })),
    });

  const base = ['Bhel Puri', 'Lamb Rogan Josh', 'Saag Aloo', 'Dal Tadka', 'Naan'];

  it('flags two menus that are near-identical (the Glas shape)', () => {
    const flags = computeReviewFlags(
      menus([
        { label: 'Late Bird Menu', dishes: base },
        { label: 'Menus', dishes: [...base, 'Kulfi'] },
      ])
    );
    expect(flags.some((f) => f.code === 'duplicate_menu')).toBe(true);
  });

  it('names BOTH menus so the reviewer knows what to compare', () => {
    const flag = computeReviewFlags(
      menus([
        { label: 'A La Carte', dishes: base },
        { label: 'Menu 2', dishes: base },
      ])
    ).find((f) => f.code === 'duplicate_menu');
    expect(flag?.label).toContain('A La Carte');
    expect(flag?.label).toContain('Menu 2');
  });

  /**
   * Overlapping menus are normal, so this flag informs the admin queue without
   * pulling the restaurant off the guide. rasam.ie's Early Bird is a reduced
   * selection of its a la carte and its Dine at Home is the same food to take
   * away; gating on the overlap withheld six correctly-parsed restaurants,
   * which is a bigger harm than the duplicate it guarded against.
   */
  it('flags but does NOT withhold — and never removes a menu', () => {
    const r = menus([
      { label: 'A La Carte', dishes: base },
      { label: 'Menu 2', dishes: base },
    ]);
    expect(computeReviewFlags(r).some((f) => f.code === 'duplicate_menu')).toBe(true);
    expect(isPubliclyVisible(r)).toBe(true);
    // Both menus are still there — nothing was removed.
    expect(r.sections).toHaveLength(2);
  });

  it('still withholds for a flag that means we read the menu WRONG', () => {
    const r = menus([
      { label: 'A La Carte', dishes: base },
      { label: 'Burgers', dishes: ['The Best Burger in Dublin'] },
    ]);
    expect(isPubliclyVisible(r)).toBe(false);
  });

  /**
   * Blauw Amsterdam's "Amsterdam" and "Utrecht" menus share 24 of 25 dishes and
   * are two genuinely different branches. Flagging them is right; removing one
   * would not be, which is exactly why this rule only ever flags.
   */
  it('flags branch menus rather than silently folding them together', () => {
    const r = menus([
      { label: 'Amsterdam', dishes: [...base, 'Bitterballen'] },
      { label: 'Utrecht', dishes: base },
    ]);
    expect(computeReviewFlags(r).some((f) => f.code === 'duplicate_menu')).toBe(true);
    expect(r.sections).toHaveLength(2);
  });

  it('does NOT flag a small menu nested inside a much larger one (Jinweide 8 vs 20)', () => {
    const large = Array.from({ length: 20 }, (_, i) => `Dish ${i}`);
    const flags = computeReviewFlags(
      menus([
        { label: 'Menu', dishes: large.slice(0, 8) },
        { label: 'A la carte', dishes: large },
      ])
    );
    expect(flags.some((f) => f.code === 'duplicate_menu')).toBe(false);
  });

  it('does NOT flag genuinely different menus', () => {
    const flags = computeReviewFlags(
      menus([
        { label: 'Lunch', dishes: base },
        { label: 'Dinner', dishes: ['Chateaubriand', 'Turbot', 'Venison', 'Grouse', 'Hare'] },
      ])
    );
    expect(flags.some((f) => f.code === 'duplicate_menu')).toBe(false);
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
    // Plenty of dishes overall (so the count gate passes and the approval
    // override is what's actually under test), but one menu is nothing more
    // than its own title — the real menu-as-dish failure.
    const flagged = restaurant([], {
      sections: [
        { id: 'a', name: 'Mains', displayOrder: 0, menuLabel: 'À la carte', dishes: manyDishes },
        {
          id: 'b',
          name: 'Tasting',
          displayOrder: 1,
          menuLabel: 'Tasting',
          dishes: [dish('Tasting Menu', '5 courses, €90 per person')],
        },
      ],
    });
    expect(isPubliclyVisible(flagged)).toBe(false);
    expect(isPubliclyVisible({ ...flagged, guideApprovedAt: '2026-07-19T00:00:00Z' })).toBe(true);
  });
});
