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
});
