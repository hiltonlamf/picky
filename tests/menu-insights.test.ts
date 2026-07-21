import { describe, it, expect } from 'vitest';
import { isMainSection, guideInsights } from '@/lib/menu-insights';
import type { Restaurant, MenuSection, Dish, DietaryClassification } from '@/types';

let idCounter = 0;
function dish(name: string, classification: DietaryClassification): Dish {
  return {
    id: `d${idCounter++}`,
    name,
    description: null,
    price: null,
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
    sections, createdAt: '2026-07-20',
  };
}

describe('isMainSection', () => {
  it('recognises main-course sections', () => {
    expect(isMainSection('Mains')).toBe(true);
    expect(isMainSection('Main Courses')).toBe(true);
    expect(isMainSection('Large Plates')).toBe(true);
    expect(isMainSection('Secondi')).toBe(true);
  });

  it('rejects non-main sections', () => {
    for (const n of ['Starters', 'Sides', 'Side Dishes', 'Desserts', 'Small Plates', 'Sharing Plates', 'Appetizers']) {
      expect(isMainSection(n)).toBe(false);
    }
  });
});

describe('guideInsights', () => {
  it('counts all veg dishes including sides, single menu', () => {
    const r = restaurant([
      section('Mains', [dish('Risotto', 'vegetarian'), dish('Steak', 'neither')]),
      section('Sides', [dish('Chips', 'vegan'), dish('Greens', 'vegan')]),
    ]);
    const ins = guideInsights(r);
    expect(ins.perMenu).toHaveLength(1);
    expect(ins.perMenu[0].vegOptions).toBe(3); // risotto + 2 vegan sides
    expect(ins.maxVegOptions).toBe(3);
    expect(ins.totalDishes).toBe(4);
  });

  it('ranks by the BEST single menu, not the sum (the SOLE case)', () => {
    const lunch = [
      section('Lunch Mains', [dish('L1', 'vegetarian'), dish('L2', 'vegan')], 'Lunch'),
    ]; // 2 veg
    const dinner = [
      section('Dinner Mains', [dish('D1', 'vegetarian'), dish('D2', 'vegetarian'), dish('D3', 'vegan')], 'Dinner'),
      section('Dinner Sides', [dish('D4', 'vegan')], 'Dinner'),
    ]; // 4 veg
    const ins = guideInsights(restaurant([...lunch, ...dinner]));
    expect(ins.perMenu).toEqual([
      { label: 'Lunch', vegOptions: 2 },
      { label: 'Dinner', vegOptions: 4 },
    ]);
    expect(ins.maxVegOptions).toBe(4); // best menu, NOT 6 (the sum)
    expect(ins.totalDishes).toBe(6);
  });

  it('highlights up to 3 veg mains, de-duplicated, from main sections only', () => {
    const r = restaurant([
      section('Starters', [dish('Soup', 'vegan')]),
      section('Mains', [
        dish('Aubergine Parmigiana', 'vegetarian'),
        dish('Mushroom Wellington', 'vegan'),
        dish('Beef', 'neither'),
        dish('Lentil Dhal', 'vegan'),
        dish('Chickpea Curry', 'vegan'),
      ]),
      section('Sides', [dish('Chips', 'vegan')]),
    ]);
    const ins = guideInsights(r);
    expect(ins.vegMains).toEqual(['Aubergine Parmigiana', 'Mushroom Wellington', 'Lentil Dhal']);
  });

  it('de-dupes the same main across menus despite veg-marker spelling', () => {
    const r = restaurant([
      section('À La Carte Mains', [dish('Pappardelle (V)', 'vegetarian')], 'À La Carte'),
      section('Dinner Mains', [dish('Pappardelle V', 'vegetarian'), dish('Aubergine', 'vegan')], 'Dinner'),
    ]);
    expect(guideInsights(r).vegMains).toEqual(['Pappardelle (V)', 'Aubergine']);
  });

  it('returns no mains when there is no main section', () => {
    const r = restaurant([section('Small Plates', [dish('Padron Peppers', 'vegan')])]);
    expect(guideInsights(r).vegMains).toEqual([]);
    expect(guideInsights(r).maxVegOptions).toBe(1);
  });
});
