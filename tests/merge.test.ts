import { describe, it, expect } from 'vitest';
import { mergeMenus, looksLikeHeaderItems } from '@/lib/menu-extract';
import { makeDish, makeMenu } from './helpers';

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
