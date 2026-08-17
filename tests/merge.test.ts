import { describe, it, expect } from 'vitest';
import { mergeMenus, looksLikeHeaderItems, collapseIdenticalMenus } from '@/lib/menu-extract';
import { makeDish, makeMenu } from './helpers';

/**
 * Two menus holding exactly the same dishes are one menu shown twice. Measured
 * in production: 14 of 88 analysed restaurants had such a pair, and rasam.ie
 * had four menus that were really two (À la carte == Early Bird, 42 for 42).
 *
 * The rule is EXACT set equality on dish names, never "mostly a subset" — a
 * real Early Bird IS a strict subset of the à la carte, so a subset rule would
 * delete genuine menus.
 */
describe('identical menus collapse into one', () => {
  const threeDishes = () => [makeDish('Bhel Puri'), makeDish('Lamb Rogan Josh'), makeDish('Saag Aloo')];

  it('folds two menus with the same dishes into a single unlabelled menu', () => {
    const merged = mergeMenus([
      { label: 'À La Carte', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
      { label: 'Early Bird', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
    ]);
    // One menu left ⇒ presented as an ordinary single menu.
    expect(merged.sections).toHaveLength(1);
    expect(merged.sections[0].menuLabel).toBeNull();
    expect(merged.sections[0].dishes).toHaveLength(3);
  });

  it('keeps the least-restricted name when three menus survive', () => {
    const merged = mergeMenus([
      { label: 'Early Bird', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
      { label: 'À La Carte', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
      { label: 'Lunch', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Dal Tadka')] }]) },
    ]);
    const labels = merged.sections.map((s) => s.menuLabel);
    // "Early Bird" would tell a diner these dishes are only served before 7pm —
    // a claim the restaurant never made. The à la carte name wins.
    expect(labels).toContain('À La Carte');
    expect(labels).not.toContain('Early Bird');
    expect(labels).toContain('Lunch');
  });

  it('does NOT collapse a real Early Bird that is a strict subset', () => {
    const merged = mergeMenus([
      {
        label: 'À La Carte',
        menu: makeMenu([{ name: 'Mains', dishes: [...threeDishes(), makeDish('Tandoori Monkfish')] }]),
      },
      { label: 'Early Bird', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
    ]);
    expect(merged.sections.map((s) => s.menuLabel)).toEqual(['À La Carte', 'Early Bird']);
  });

  it('ignores price: the same dishes at two price points is still one menu', () => {
    const priced = (price: string) => [
      makeDish('Bhel Puri', { price }),
      makeDish('Lamb Rogan Josh', { price }),
      makeDish('Saag Aloo', { price }),
    ];
    const merged = mergeMenus([
      { label: 'À La Carte', menu: makeMenu([{ name: 'Mains', dishes: priced('€22') }]) },
      { label: 'Early Bird', menu: makeMenu([{ name: 'Mains', dishes: priced('€18') }]) },
    ]);
    expect(merged.sections).toHaveLength(1);
  });

  it('needs at least three dishes — two tiny menus matching proves nothing', () => {
    const merged = mergeMenus([
      { label: 'Lunch', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Soup'), makeDish('Bread')] }]) },
      { label: 'Dinner', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Soup'), makeDish('Bread')] }]) },
    ]);
    expect(merged.sections.map((s) => s.menuLabel)).toEqual(['Lunch', 'Dinner']);
  });

  it('leaves genuinely different menus alone', () => {
    const merged = mergeMenus([
      { label: 'Lunch', menu: makeMenu([{ name: 'Mains', dishes: threeDishes() }]) },
      {
        label: 'Dinner',
        menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Chateaubriand'), makeDish('Turbot'), makeDish('Venison')] }]),
      },
    ]);
    expect(merged.sections.map((s) => s.menuLabel)).toEqual(['Lunch', 'Dinner']);
  });

  it('a specific name is promoted over a generic "Menu"', () => {
    const sections = [
      { name: 'Mains', dishes: threeDishes(), menuLabel: 'Menu' },
      { name: 'Mains', dishes: threeDishes(), menuLabel: 'À La Carte' },
      { name: 'Sides', dishes: [makeDish('Naan')], menuLabel: 'Lunch' },
    ];
    const out = collapseIdenticalMenus(sections);
    expect(out.map((s) => s.menuLabel)).toEqual(['À La Carte', 'Lunch']);
  });

  /**
   * JavaScript's \b is ASCII-only, so `\bà` never matches and the accented
   * spelling silently fell through every name-ranking check. Both spellings
   * are common on Irish menus, so both are pinned.
   */
  it.each(['À La Carte', 'A La Carte', 'à la carte', 'Alacarte'])(
    'ranks "%s" above Early Bird despite the accent',
    (carte) => {
      const out = collapseIdenticalMenus([
        { name: 'Mains', dishes: threeDishes(), menuLabel: 'Early Bird' },
        { name: 'Mains', dishes: threeDishes(), menuLabel: carte },
        { name: 'Sides', dishes: [makeDish('Naan')], menuLabel: 'Lunch' },
      ]);
      expect(out.map((s) => s.menuLabel)).toEqual([carte, 'Lunch']);
    }
  );

  it('leaves untagged sections alone', () => {
    const sections = [{ name: 'Mains', dishes: threeDishes(), menuLabel: null }];
    expect(collapseIdenticalMenus(sections)).toEqual(sections);
  });
});

describe('mergeMenus per-menu grouping', () => {
  it('tags sections with their source menu label when multiple menus merge', () => {
    const merged = mergeMenus([
      { label: 'Lunch', menu: makeMenu([{ name: 'Starters', dishes: [makeDish('Soup')] }]) },
      { label: 'Dinner', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Risotto')] }]) },
    ]);
    expect(merged.sections).toHaveLength(2);
    expect(merged.sections[0].menuLabel).toBe('Lunch');
    expect(merged.sections[1].menuLabel).toBe('Dinner');
    // No more "Label — Section" name mangling
    expect(merged.sections[0].name).toBe('Starters');
  });

  it('leaves menuLabel null for single-menu results (renders as before)', () => {
    const merged = mergeMenus([
      { label: 'Menu', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Risotto')] }]) },
    ]);
    expect(merged.sections[0].menuLabel).toBeNull();
    expect(merged.sections[0].name).toBe('Mains');
  });

  it('keeps a dish that appears on BOTH lunch and dinner (no cross-menu dedup)', () => {
    const merged = mergeMenus([
      { label: 'Lunch', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Risotto', { price: '€15' })] }]) },
      { label: 'Dinner', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Risotto', { price: '€15' })] }]) },
    ]);
    const all = merged.sections.flatMap((s) => s.dishes);
    expect(all).toHaveLength(2);
    expect(merged.sections.map((s) => s.menuLabel)).toEqual(['Lunch', 'Dinner']);
  });

  it('dedups the same dish WITHIN one menu, keeping the highest-confidence copy', () => {
    const merged = mergeMenus([
      {
        label: 'Dinner',
        menu: makeMenu([
          { name: 'Mains', dishes: [makeDish('Paella', { confidence: 0.5 })] },
          { name: 'Specials', dishes: [makeDish('Paella', { confidence: 0.9 })] },
        ]),
      },
      { label: 'Lunch', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Soup')] }]) },
    ]);
    const dinnerDishes = merged.sections.filter((s) => s.menuLabel === 'Dinner').flatMap((s) => s.dishes);
    expect(dinnerDishes).toHaveLength(1);
    expect(dinnerDishes[0].confidence).toBe(0.9);
  });

  it('dedups exact duplicates within a single menu even at equal confidence', () => {
    const merged = mergeMenus([
      {
        label: 'Menu',
        menu: makeMenu([
          { name: 'Tapas', dishes: [makeDish('Patatas Bravas')] },
          { name: 'Raciones', dishes: [makeDish('Patatas Bravas')] },
        ]),
      },
    ]);
    expect(merged.sections.flatMap((s) => s.dishes)).toHaveLength(1);
  });

  // kickys.ie bug: ONE discovered candidate (one subpage) whose own text names
  // several distinct menus back to back ("À La Carte", "A Taste of Kicky's",
  // "Groups"). Discovery never split these into separate candidates, so
  // named.length === 1 — but the extraction itself (SYSTEM_PROMPT's "multiple
  // distinct named menus" rule) tags each section with its own menuLabel, and
  // that must survive mergeMenus rather than being nulled out by the
  // named.length > 1 check, or the UI flattens them onto one page.
  it('preserves a menuLabel the extraction itself assigned, even from a single candidate', () => {
    const merged = mergeMenus([
      {
        label: 'Menu', // the one subpage candidate's own (outer) label
        menu: makeMenu([
          { name: 'Bites', dishes: [makeDish('Focaccia')], menuLabel: 'À La Carte' },
          { name: 'Bites', dishes: [makeDish('Croquettes')], menuLabel: "A Taste of Kicky's" },
        ]),
      },
    ]);
    expect(merged.sections).toHaveLength(2);
    expect(merged.sections.map((s) => s.menuLabel)).toEqual(['À La Carte', "A Taste of Kicky's"]);
    // Section names stay clean — the menu name lives in menuLabel, not baked
    // into the name (the actual symptom: "A La Carte - Bites" as a name).
    expect(merged.sections.every((s) => s.name === 'Bites')).toBe(true);
  });

  it('does not cross-dedup a same-named dish that legitimately appears on two internally-split menus', () => {
    const merged = mergeMenus([
      {
        label: 'Menu',
        menu: makeMenu([
          { name: 'Sides', dishes: [makeDish('Fries', { price: '€5' })], menuLabel: 'À La Carte' },
          { name: 'Sides', dishes: [makeDish('Fries', { price: '€5' })], menuLabel: 'Groups' },
        ]),
      },
    ]);
    expect(merged.sections.flatMap((s) => s.dishes)).toHaveLength(2);
  });

  it('still nulls menuLabel for an ordinary single-menu, single-candidate result (no regression)', () => {
    const merged = mergeMenus([
      { label: 'Menu', menu: makeMenu([{ name: 'Mains', dishes: [makeDish('Risotto')] }]) },
    ]);
    expect(merged.sections[0].menuLabel).toBeNull();
  });
});

describe('looksLikeHeaderItems', () => {
  it('flags extractions that are mostly section headers', () => {
    const menu = makeMenu([
      {
        name: 'Menus',
        dishes: [
          makeDish('Daily Dim Sum Menu'),
          makeDish('Set Lunch Menu'),
          makeDish('Tasting Menu'),
        ],
      },
    ]);
    expect(looksLikeHeaderItems(menu)).toBe(true);
  });

  it('accepts real dish lists', () => {
    const menu = makeMenu([
      {
        name: 'Mains',
        dishes: [
          makeDish('Char siu bao', { price: '€8', description: 'BBQ pork bun' }),
          makeDish('Har gow', { price: '€7', description: 'Prawn dumpling' }),
          makeDish('Mapo tofu', { price: '€12', description: 'Sichuan classic' }),
        ],
      },
    ]);
    expect(looksLikeHeaderItems(menu)).toBe(false);
  });
});
