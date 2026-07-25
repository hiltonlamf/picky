import { describe, it, expect } from 'vitest';
import { parsePrice, guideInsights } from '@/lib/menu-insights';
import type { Restaurant, MenuSection, Dish, DietaryClassification } from '@/types';

let idCounter = 0;
function dish(name: string, classification: DietaryClassification, price: string | null = null): Dish {
  return {
    id: `d${idCounter++}`,
    name,
    description: null,
    price,
    classification,
    confidence: 0.9,
    reportCount: 0,
    warningFlagged: false,
    humanVerified: false,
    origin: 'ai',
  };
}

function section(name: string, dishes: Dish[], menuLabel: string | null = null): MenuSection {
  return { id: `s${idCounter++}`, name, displayOrder: 0, menuLabel, dishes };
}

function restaurant(sections: MenuSection[]): Restaurant {
  return {
    id: 'r1', url: 'https://example.com', city: 'dublin', status: 'done',
    sections, createdAt: '2026-07-21',
  };
}

describe('parsePrice', () => {
  it('parses common formats', () => {
    expect(parsePrice('€7.50')).toBe(7.5);
    expect(parsePrice('€29')).toBe(29);
    expect(parsePrice('12')).toBe(12);
    expect(parsePrice('8.00')).toBe(8);
    expect(parsePrice('£12.50')).toBe(12.5);
  });
  it('returns null for missing/unparseable', () => {
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('Market Price')).toBeNull();
  });
});

describe('guideInsights', () => {
  it('ranks by the BEST single menu and splits vegan/veggie for that menu', () => {
    const lunch = [section('Lunch', [dish('L1', 'vegetarian'), dish('L2', 'vegan')], 'Lunch')]; // 2 veg
    const dinner = [
      section('Dinner', [dish('D1', 'vegetarian'), dish('D2', 'vegetarian'), dish('D3', 'vegan')], 'Dinner'),
    ]; // 3 veg (2 veggie, 1 vegan)
    const ins = guideInsights(restaurant([...lunch, ...dinner]));
    expect(ins.maxVegOptions).toBe(3); // best menu, not 5 (the sum)
    expect(ins.bestMenu).toEqual({ label: 'Dinner', vegan: 1, vegetarian: 2 });
    expect(ins.perMenu).toEqual([
      { label: 'Lunch', vegOptions: 2 },
      { label: 'Dinner', vegOptions: 3 },
    ]);
    expect(ins.totalDishes).toBe(5);
  });

  it('highlights up to 3 priciest veg dishes, de-duped across menus, with prices', () => {
    const r = restaurant([
      section('Starters', [dish('Soup', 'vegan', '€6')]),
      section('Mains', [
        dish('Truffle Risotto', 'vegetarian', '€24'),
        dish('Aubergine (V)', 'vegan', '€19'),
        dish('Aubergine V', 'vegan', '€19'), // same dish, different spelling → deduped
        dish('Wellington', 'vegan', '€22'),
        dish('Steak', 'neither', '€30'), // not veg → excluded
        dish('No Price Special', 'vegan', null), // unpriced → excluded from this list (still counts elsewhere)
      ]),
    ]);
    const ins = guideInsights(r);
    expect(ins.highlights).toEqual([
      { name: 'Truffle Risotto', price: '€24' },
      { name: 'Wellington', price: '€22' },
      { name: 'Aubergine (V)', price: '€19' },
    ]);
    expect(ins.highlightsAreThin).toBe(false);
  });

  it('formats a bare numeric price with a currency symbol in highlights', () => {
    const r = restaurant([section('Mains', [dish('Bare price main', 'vegan', '18')])]);
    expect(guideInsights(r).highlights).toEqual([{ name: 'Bare price main', price: '€18' }]);
  });

  it('falls back to veg dishes in menu order when none are priced (tasting menus)', () => {
    const r = restaurant([
      section('Courses', [
        dish('Heritage tomatoes', 'vegan', null),
        dish('Wild mushroom', 'vegetarian', null),
        dish('Rhubarb & custard', 'vegetarian', null),
        dish('Petit fours', 'vegan', null),
        dish('Beef course', 'neither', null), // not veg → excluded
      ]),
    ]);
    // No prices to rank by, so show the first 3 veg dishes as they appear.
    expect(guideInsights(r).highlights).toEqual([
      { name: 'Heritage tomatoes', price: null },
      { name: 'Wild mushroom', price: null },
      { name: 'Rhubarb & custard', price: null },
    ]);
  });

  it('tops up priced highlights with unpriced veg dishes when fewer than 3 are priced', () => {
    const r = restaurant([
      section('Menu', [
        dish('Priced main', 'vegan', '€18'),
        dish('Side salad', 'vegan', null),
        dish('Bread', 'vegetarian', null),
      ]),
    ]);
    // One priced dish leads; unpriced veg fills the remaining slots in order.
    expect(guideInsights(r).highlights).toEqual([
      { name: 'Priced main', price: '€18' },
      { name: 'Side salad', price: null },
      { name: 'Bread', price: null },
    ]);
  });

  it('excludes soft-deleted dishes', () => {
    const d = dish('Deleted', 'vegan', '€40');
    d.deletedAt = '2026-07-20';
    const r = restaurant([section('Menu', [d, dish('Live', 'vegetarian', '€10')])]);
    const ins = guideInsights(r);
    expect(ins.totalDishes).toBe(1);
    expect(ins.highlights).toEqual([{ name: 'Live', price: '€10' }]);
  });

  describe('highlightsAreThin', () => {
    it('is true when fewer than 3 veg dishes exist at all', () => {
      const r = restaurant([
        section('Menu', [dish('Seeded sourdough, cultured butter', 'vegetarian', '€6')], null),
        section('Saturday Lunch', [dish('Seeded sourdough', 'vegetarian', '€5')], 'Saturday Lunch'),
      ]);
      expect(guideInsights(r).highlightsAreThin).toBe(true);
    });

    it('is true when 3 veg dishes exist but all come from side/dessert/bread sections', () => {
      const r = restaurant([
        section('Desserts', [
          dish('Sticky toffee pudding', 'vegetarian', '€9'),
          dish('Sorbet', 'vegan', '€7'),
        ]),
        section('Bread', [dish('Sourdough & butter', 'vegetarian', '€5')]),
      ]);
      expect(guideInsights(r).highlightsAreThin).toBe(true);
    });

    it('is false when at least one of the top 3 highlights is a main', () => {
      const r = restaurant([
        section('Mains', [dish('Truffle Risotto', 'vegetarian', '€24')]),
        section('Desserts', [
          dish('Sticky toffee pudding', 'vegetarian', '€9'),
          dish('Sorbet', 'vegan', '€7'),
        ]),
      ]);
      expect(guideInsights(r).highlightsAreThin).toBe(false);
    });
  });
});
