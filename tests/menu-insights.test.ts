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

  // Stripping non-digits turned a €12.99 pizza into €912.99, which put it top
  // of the "priciest first" highlight ranking at several restaurants.
  it('survives sizes, ranges and decimal commas', () => {
    expect(parsePrice('9" €12.99 / 12" €14.99')).toBe(12.99); // not 912.991214
    expect(parsePrice('€18 (dinner) / €16 (lunch)')).toBe(18);
    expect(parsePrice('€8–€11')).toBe(8);
    expect(parsePrice('Half dozen €21 | Dozen €42')).toBe(21);
    expect(parsePrice('3,75')).toBe(3.75); // Dutch decimal comma, not 375
    expect(parsePrice('38/70')).toBe(38);
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
      { label: 'Lunch', vegOptions: 2, asideOptions: 0 },
      { label: 'Dinner', vegOptions: 3, asideOptions: 0 },
    ]);
    expect(ins.totalDishes).toBe(5);
    expect(ins.asideCount).toBe(0);
  });

  it('splits the headline count from sides and sweets', () => {
    const r = restaurant([
      section('Mains', [dish('Wild mushroom risotto', 'vegetarian', '€22')]),
      section('Sides', [dish('Butter Naan', 'vegetarian', '€3')]),
      section('Desserts', [dish('Gulab Jamun', 'vegetarian', '€8')]),
    ]);
    const ins = guideInsights(r);
    expect(ins.maxVegOptions).toBe(1); // the risotto alone
    expect(ins.asideCount).toBe(2); // naan + pudding, shown but not counted
    expect(ins.totalDishes).toBe(3); // nothing is hidden
  });

  it('counts the same dish once when a tasting menu repeats the a la carte', () => {
    // Cornerstore's "Tasting Menu – Vegetarian" is its own plates bundled, and
    // both carry no menuLabel — so six dishes were counted as eleven.
    const r = restaurant([
      section('Snacks', [dish('Crispy tofu', 'vegan', '€8'), dish('Lotus root pickle', 'vegan', '€7')]),
      section('Tasting Menu – Vegetarian', [
        dish('Crispy tofu', 'vegan', '€8'),
        dish('Lotus root pickle', 'vegan', '€7'),
        dish('Smoked tofu, green peas', 'vegan', '€12'),
      ]),
    ]);
    const ins = guideInsights(r);
    expect(ins.maxVegOptions).toBe(3); // not 5
    expect(ins.bestMenu.vegan).toBe(3); // the split de-dupes the same way
    expect(ins.totalDishes).toBe(5); // nothing is removed from the menu itself
  });

  describe('the price tiebreak for bar snacks', () => {
    // Only fires in an explicit bar-snack section, and only under half the
    // restaurant's median price.
    const withMains = (extra: MenuSection[]) =>
      restaurant([
        section('Mains', [
          dish('Risotto', 'vegetarian', '€20'),
          dish('Steak', 'neither', '€28'),
          dish('Cod', 'neither', '€24'),
          dish('Gnocchi', 'vegetarian', '€19'),
        ]),
        ...extra,
      ]);

    it('demotes a cheap nibble but keeps a substantial one', () => {
      const ins = guideInsights(
        withMains([
          section('Nibbles', [
            dish('Tartine bread and olive oil', 'vegetarian', '€4'), // ~19% of median
            dish('Padron pepper and romesco', 'vegan', '€12'), // ~57%, a real plate
          ]),
        ])
      );
      expect(ins.maxVegOptions).toBe(3); // risotto, gnocchi, padron — not the tartine
      expect(ins.asideCount).toBe(1);
    });

    it('never touches a "Sides" section, where the veg mains live', () => {
      // Pickle's curries run €8.50–€14.50 against €38 mains. A price rule that
      // reached them would delete the whole point of this feature.
      const ins = guideInsights(
        withMains([
          section('Condiments/Sides', [
            dish('Palak Paneer', 'vegetarian', '€8.50'),
            dish('Bhindi Masala', 'vegetarian', '€8'),
          ]),
        ])
      );
      expect(ins.maxVegOptions).toBe(4);
    });

    it('keeps an unpriced nibble — we cannot judge what we cannot see', () => {
      const ins = guideInsights(withMains([section('Snacks', [dish('Mystery plate', 'vegan', null)])]));
      expect(ins.maxVegOptions).toBe(3);
    });

    // Cuts the other way too. A Thai kitchen names main courses "… Sauce":
    // Baan Thai sells "Tamarind Sauce" at €26.50 against a €20.95 median.
    it('rescues an expensive dish named "… sauce" from the condiment rule', () => {
      const ins = guideInsights(
        withMains([
          section('Signature', [
            dish('Tamarind Sauce', 'vegetarian', '€26.50'), // a main course
            dish('Mint Sauce', 'vegetarian', '€2.75'), // an actual condiment
          ]),
        ])
      );
      expect(ins.maxVegOptions).toBe(3); // risotto, gnocchi, tamarind
      expect(ins.asideCount).toBe(1); // the mint sauce
    });

    it('leaves an unpriced "… sauce" as a condiment', () => {
      const ins = guideInsights(withMains([section('Signature', [dish('Chilli Sauce', 'vegan', null)])]));
      expect(ins.maxVegOptions).toBe(2);
    });
  });

  it('counts "unknown" dishes as veggie — when in doubt, count it', () => {
    const r = restaurant([
      section('Mains', [dish('Soup of the day', 'unknown', '€8'), dish('Risotto', 'vegetarian', '€20')]),
    ]);
    expect(guideInsights(r).maxVegOptions).toBe(2);
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

  it('does not count, highlight or tally shared protein choices as sides', () => {
    const r = restaurant([
      section('Protein Customization Options', [
        dish('Tofu', 'unknown', '€20.95'),
        dish('Vegetable', 'unknown', '€20.95'),
        dish('Chicken', 'neither', '€23.50'),
      ]),
      section('Curries', [
        dish('Green Curry', 'vegan', '€20.95–€27.95'),
        dish('Red Curry', 'vegan', '€20.95–€27.95'),
        dish('Vegan Yellow Curry', 'vegan', '€20.95–€27.95'),
      ]),
    ]);

    const ins = guideInsights(r);
    expect(ins.maxVegOptions).toBe(3);
    expect(ins.asideCount).toBe(0);
    expect(ins.totalDishes).toBe(3);
    expect(ins.highlights.map((highlight) => highlight.name)).toEqual([
      'Green Curry',
      'Red Curry',
      'Vegan Yellow Curry',
    ]);
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
        dish('Grilled aubergine', 'vegetarian', null),
      ]),
    ]);
    // One priced dish leads; unpriced veg fills the remaining slots in order.
    expect(guideInsights(r).highlights).toEqual([
      { name: 'Priced main', price: '€18' },
      { name: 'Side salad', price: null },
      { name: 'Grilled aubergine', price: null },
    ]);
  });

  it('never headlines a bread or a pudding', () => {
    const r = restaurant([
      section('Menu', [
        dish('Tandoori Bread Basket', 'vegetarian', '€9.95'), // priciest, but bread
        dish('Paneer Tikka', 'vegetarian', '€8'),
      ]),
    ]);
    expect(guideInsights(r).highlights).toEqual([{ name: 'Paneer Tikka', price: '€8' }]);
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

    it('is true when the only veg dishes are desserts, since none can be highlighted', () => {
      // Desserts are excluded from the count entirely now, so there is nothing
      // left to showcase — the card must say so rather than imply three picks.
      const r = restaurant([
        section('Mains', [dish('Truffle Risotto', 'vegetarian', '€24')]),
        section('Desserts', [
          dish('Sticky toffee pudding', 'vegetarian', '€9'),
          dish('Sorbet', 'vegan', '€7'),
        ]),
      ]);
      expect(guideInsights(r).highlights).toEqual([{ name: 'Truffle Risotto', price: '€24' }]);
      expect(guideInsights(r).highlightsAreThin).toBe(true);
    });

    it('is false when three countable dishes exist and one is a main', () => {
      const r = restaurant([
        section('Mains', [dish('Truffle Risotto', 'vegetarian', '€24')]),
        section('Sides', [
          dish('Truffle Mac & Cheese', 'vegetarian', '€9'),
          dish('Creamed Spinach', 'vegetarian', '€7'),
        ]),
      ]);
      expect(guideInsights(r).highlightsAreThin).toBe(false);
    });
  });
});
