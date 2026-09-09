import { describe, it, expect } from 'vitest';
import { countLiveRestaurantsByCity } from '@/lib/db';
import { MIN_GUIDE_DISHES, isPubliclyVisible } from '@/lib/review-flags';
import type { Dish, MenuSection, Restaurant } from '@/types';

/**
 * The count on /guides and the list on a guide page are the same number stated
 * twice. This file exists to keep them that way.
 *
 * The two paths reach it differently — the guide page loads whole restaurants
 * and filters them with `isPubliclyVisible`; /guides assembles the bare minimum
 * that predicate reads, from batched rows. So every case below is asserted
 * against `isPubliclyVisible` directly, not against a hardcoded number: if the
 * visibility rules change, this test follows them instead of going stale.
 */

let seq = 0;

function dishRow(restaurantId: string, sectionId: string | null, name: string) {
  return {
    id: `d${seq++}`,
    restaurant_id: restaurantId,
    section_id: sectionId,
    name,
    description: null,
    price: '€18.00',
    classification: 'vegetarian',
    confidence: 0.9,
    report_count: 0,
    warning_flagged: false,
    human_verified: false,
    origin: 'ai',
    deleted_at: null,
  };
}

function sectionRow(restaurantId: string, id: string, name: string) {
  return { id, restaurant_id: restaurantId, name, display_order: 0, menu_label: null };
}

/** Mirrors what fetchRestaurantWithDishes hands the guide page. */
function asRestaurant(sections: MenuSection[], status: string, guideApprovedAt: string | null) {
  return { sections, status, guideApprovedAt } as unknown as Restaurant;
}

function dishes(n: number, restaurantId: string, sectionId: string | null): ReturnType<typeof dishRow>[] {
  return Array.from({ length: n }, (_, i) => dishRow(restaurantId, sectionId, `Dish ${i}`));
}

/** Builds the sections the guide page would see, from the same raw rows. */
function sectionsFor(sectionRows: ReturnType<typeof sectionRow>[], dishRows: ReturnType<typeof dishRow>[]): MenuSection[] {
  const list: MenuSection[] = sectionRows.map((s) => ({
    id: s.id,
    name: s.name,
    displayOrder: s.display_order,
    menuLabel: s.menu_label,
    dishes: dishRows
      .filter((d) => d.section_id === s.id)
      .map((d) => ({ ...d, reportCount: 0, deletedAt: null }) as unknown as Dish),
  }));
  const loose = dishRows.filter((d) => !d.section_id);
  if (loose.length) {
    list.push({
      id: 'unsectioned',
      name: 'Menu',
      displayOrder: 999,
      menuLabel: null,
      dishes: loose.map((d) => ({ ...d, reportCount: 0, deletedAt: null }) as unknown as Dish),
    });
  }
  return list;
}

describe('countLiveRestaurantsByCity', () => {
  it('counts exactly the restaurants the guide page would show', () => {
    // Comfortably over the bar, plainly named so no review flag fires.
    const okSections = [sectionRow('r-ok', 's1', 'Mains')];
    const okDishes = dishes(MIN_GUIDE_DISHES + 3, 'r-ok', 's1');
    // Under MIN_GUIDE_DISHES — withheld as a probable mis-parse.
    const thinSections = [sectionRow('r-thin', 's2', 'Mains')];
    const thinDishes = dishes(2, 'r-thin', 's2');

    const restaurantRows = [
      { id: 'r-ok', status: 'done', guide_approved_at: null },
      { id: 'r-thin', status: 'done', guide_approved_at: null },
      { id: 'r-error', status: 'error', guide_approved_at: null },
    ];
    const featured = [
      { city: 'dublin', restaurant_id: 'r-ok' },
      { city: 'dublin', restaurant_id: 'r-thin' },
      { city: 'dublin', restaurant_id: 'r-error' },
    ];

    const counts = countLiveRestaurantsByCity(
      featured,
      restaurantRows,
      [...okSections, ...thinSections],
      [...okDishes, ...thinDishes]
    );

    // What the guide page itself would conclude, restaurant by restaurant.
    const guidePageCount = [
      asRestaurant(sectionsFor(okSections, okDishes), 'done', null),
      asRestaurant(sectionsFor(thinSections, thinDishes), 'done', null),
      asRestaurant([], 'error', null),
    ].filter(isPubliclyVisible).length;

    expect(counts.get('dublin')).toBe(guidePageCount);
    expect(counts.get('dublin')).toBe(1);
  });

  it('never counts a manually-hidden restaurant', () => {
    const sections = [sectionRow('r1', 's1', 'Mains')];
    const dishRows = dishes(MIN_GUIDE_DISHES + 1, 'r1', 's1');
    const restaurantRows = [{ id: 'r1', status: 'done', guide_approved_at: null }];

    // getPublishedCityGuides strips hidden rows before calling this, so a
    // hidden restaurant simply never appears in `featured`.
    expect(countLiveRestaurantsByCity([], restaurantRows, sections, dishRows).get('dublin')).toBeUndefined();
    expect(
      countLiveRestaurantsByCity(
        [{ city: 'dublin', restaurant_id: 'r1' }],
        restaurantRows,
        sections,
        dishRows
      ).get('dublin')
    ).toBe(1);
  });

  it('counts dishes that belong to no section, like the guide page does', () => {
    // Loose dishes land in the synthetic "unsectioned" section; miss them and a
    // perfectly good restaurant reads as having zero dishes.
    const dishRows = dishes(MIN_GUIDE_DISHES + 1, 'r1', null);
    const counts = countLiveRestaurantsByCity(
      [{ city: 'cork', restaurant_id: 'r1' }],
      [{ id: 'r1', status: 'done', guide_approved_at: null }],
      [],
      dishRows
    );

    expect(counts.get('cork')).toBe(1);
    expect(isPubliclyVisible(asRestaurant(sectionsFor([], dishRows), 'done', null))).toBe(true);
  });

  it('honours a human approval that overrides the review flags', () => {
    const sections = [sectionRow('r1', 's1', 'Tasting Menu')];
    // A single "dish" that is really a whole menu — flagged, unless a human has
    // looked at it and approved it.
    const dishRows = dishes(MIN_GUIDE_DISHES + 1, 'r1', 's1');
    dishRows[0].name = 'Tasting Menu';

    const featured = [{ city: 'dublin', restaurant_id: 'r1' }];
    const unapproved = countLiveRestaurantsByCity(
      featured,
      [{ id: 'r1', status: 'done', guide_approved_at: null }],
      sections,
      dishRows
    );
    const approved = countLiveRestaurantsByCity(
      featured,
      [{ id: 'r1', status: 'done', guide_approved_at: '2026-09-01T00:00:00Z' }],
      sections,
      dishRows
    );

    // Whatever the flags decide, both paths must decide it identically.
    expect(unapproved.get('dublin') ?? 0).toBe(
      isPubliclyVisible(asRestaurant(sectionsFor(sections, dishRows), 'done', null)) ? 1 : 0
    );
    expect(approved.get('dublin')).toBe(1);
  });

  it("keeps each city's count to its own restaurants", () => {
    const sections = [sectionRow('r1', 's1', 'Mains'), sectionRow('r2', 's2', 'Mains')];
    const dishRows = [
      ...dishes(MIN_GUIDE_DISHES + 1, 'r1', 's1'),
      ...dishes(MIN_GUIDE_DISHES + 1, 'r2', 's2'),
    ];
    const counts = countLiveRestaurantsByCity(
      [
        { city: 'dublin', restaurant_id: 'r1' },
        { city: 'cork', restaurant_id: 'r2' },
      ],
      [
        { id: 'r1', status: 'done', guide_approved_at: null },
        { id: 'r2', status: 'done', guide_approved_at: null },
      ],
      sections,
      dishRows
    );

    expect(counts.get('dublin')).toBe(1);
    expect(counts.get('cork')).toBe(1);
  });

  it('returns no entry for a city whose restaurants are all withheld', () => {
    const sections = [sectionRow('r1', 's1', 'Mains')];
    const dishRows = dishes(2, 'r1', 's1');
    const counts = countLiveRestaurantsByCity(
      [{ city: 'limerick', restaurant_id: 'r1' }],
      [{ id: 'r1', status: 'done', guide_approved_at: null }],
      sections,
      dishRows
    );

    // The caller renders this as "Nothing live yet", never as a missing tile.
    expect(counts.get('limerick')).toBeUndefined();
  });
});
