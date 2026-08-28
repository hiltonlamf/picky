import { describe, expect, it } from 'vitest';
import { isModifierSectionName, modifierDishes } from '@/lib/menu-modifiers';
import { makeDish } from './helpers';

describe('menu modifier detection', () => {
  it('recognises explicit protein-choice sections without matching broad extras sections', () => {
    expect(isModifierSectionName('Protein Customization Options')).toBe(true);
    expect(isModifierSectionName('Choose your protein')).toBe(true);
    expect(isModifierSectionName('Choice of protein')).toBe(true);
    expect(isModifierSectionName('Main ingredient choices')).toBe(true);
    expect(isModifierSectionName('Extras')).toBe(false);
    expect(isModifierSectionName('Classics - Supplements')).toBe(false);
  });

  it('needs a cluster before treating a bare ingredient name as a variation', () => {
    const pizza = {
      name: 'Round Pies',
      dishes: [makeDish('Mushroom'), makeDish('Margherita'), makeDish('Pepperoni')],
    };
    expect(modifierDishes(pizza).size).toBe(0);
  });

  it('keeps described dishes even when several have short protein-led names', () => {
    const mains = {
      name: 'Mains',
      dishes: [
        makeDish('Chicken', { description: 'Roast chicken with potatoes' }),
        makeDish('Beef', { description: 'Braised beef with carrots' }),
        makeDish('Vegetable', { description: 'Seasonal vegetable pie' }),
      ],
    };
    expect(modifierDishes(mains).size).toBe(0);
  });
});
