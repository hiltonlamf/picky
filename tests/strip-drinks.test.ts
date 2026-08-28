import { describe, it, expect } from 'vitest';
import { stripDrinksAndHeaders, countFoodItems } from '@/lib/ai';
import { makeDish, makeMenu } from './helpers';

describe('stripDrinksAndHeaders', () => {
  it('removes whole drink sections', () => {
    const menu = makeMenu([
      { name: 'Wine List', dishes: [makeDish('Rioja Crianza', { price: '€32' })] },
      { name: 'Mains', dishes: [makeDish('Risotto', { price: '€15' })] },
    ]);
    const cleaned = stripDrinksAndHeaders(menu);
    expect(cleaned.sections).toHaveLength(1);
    expect(cleaned.sections[0].name).toBe('Mains');
  });

  it('removes leaked drink dishes inside food sections', () => {
    const menu = makeMenu([
      {
        name: 'Mains',
        dishes: [makeDish('Risotto'), makeDish('House red wine'), makeDish('Espresso martini')],
      },
    ]);
    const cleaned = stripDrinksAndHeaders(menu);
    expect(cleaned.sections[0].dishes.map((d) => d.name)).toEqual(['Risotto']);
  });

  it('removes header-style pseudo-dishes ("Set Menu", "Starter Selection")', () => {
    const menu = makeMenu([
      {
        name: 'Menus',
        dishes: [makeDish('Set Menu'), makeDish('Starter selection'), makeDish('Beef bourguignon', { price: '€19' })],
      },
    ]);
    const cleaned = stripDrinksAndHeaders(menu);
    expect(cleaned.sections[0].dishes.map((d) => d.name)).toEqual(['Beef bourguignon']);
  });

  it('handles non-English drink section names', () => {
    const menu = makeMenu([
      { name: 'Boissons', dishes: [makeDish('Jus d\'orange')] },
      { name: 'Plats', dishes: [makeDish('Ratatouille')] },
    ]);
    const cleaned = stripDrinksAndHeaders(menu);
    expect(cleaned.sections.map((s) => s.name)).toEqual(['Plats']);
  });

  it('drops sections left empty after filtering and counts correctly', () => {
    const menu = makeMenu([
      { name: 'Drinks Corner', dishes: [makeDish('Craft beer'), makeDish('Cola')] },
      { name: 'Food', dishes: [makeDish('Falafel wrap')] },
    ]);
    const cleaned = stripDrinksAndHeaders(menu);
    expect(cleaned.sections).toHaveLength(1);
    expect(countFoodItems(cleaned)).toBe(1);
  });

  it('removes a shared protein-price section instead of treating choices as dishes', () => {
    const menu = makeMenu([
      {
        name: 'Protein Customization Options',
        dishes: [
          makeDish('Tofu', { price: '20.95', description: 'Customizable protein option' }),
          makeDish('Vegetable', { price: '20.95', description: 'Customizable protein option' }),
          makeDish('Chicken', { price: '23.50', classification: 'neither' }),
        ],
      },
      { name: 'Curries', dishes: [makeDish('Green Curry')] },
    ]);

    expect(stripDrinksAndHeaders(menu).sections.map((section) => section.name)).toEqual(['Curries']);
  });

  it('removes a cluster of bare variations mixed into real dishes', () => {
    const menu = makeMenu([
      {
        name: 'Soups',
        dishes: [
          makeDish('Tom Yum Soup', { description: 'Hot and sour soup' }),
          makeDish('Prawns', { price: '10', classification: 'neither' }),
          makeDish('Chicken', { price: '10', classification: 'neither' }),
          makeDish('Mushroom', { price: '9' }),
          makeDish('Vegetables', { price: '9' }),
        ],
      },
    ]);

    expect(stripDrinksAndHeaders(menu).sections[0].dishes.map((dish) => dish.name)).toEqual(['Tom Yum Soup']);
  });

  it('corrects caviar rows the classifier marked vegetarian', () => {
    const menu = makeMenu([
      {
        name: 'Caviar - Individual Options',
        dishes: [
          makeDish('Sevruga Royal', { classification: 'vegetarian' }),
          makeDish('Oscietra Royal', { classification: 'unknown' }),
        ],
      },
    ]);

    const dishes = stripDrinksAndHeaders(menu).sections[0].dishes;
    expect(dishes.map((dish) => dish.classification)).toEqual(['neither', 'neither']);
    expect(dishes.every((dish) => dish.reason === 'Explicit fish or seafood ingredient')).toBe(true);
  });

  it('corrects explicit seafood while preserving plant-based lookalikes', () => {
    const menu = makeMenu([
      {
        name: 'Appetisers',
        dishes: [
          makeDish('West Cork Rope Mussels', { classification: 'vegetarian' }),
          makeDish('Oyster Mushroom Tempura', { classification: 'vegan' }),
          makeDish('Plant-based tuna tostada', { classification: 'vegan' }),
        ],
      },
    ]);

    const dishes = stripDrinksAndHeaders(menu).sections[0].dishes;
    expect(dishes.map((dish) => dish.classification)).toEqual(['neither', 'vegan', 'vegan']);
  });
});
