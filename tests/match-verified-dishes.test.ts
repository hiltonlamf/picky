import { describe, it, expect } from 'vitest';
import { matchVerifiedDishes } from '@/lib/db';

// Pure matching helper behind the saveClassifiedMenu reparse-preservation fix
// (the "landmine": saveClassifiedMenu hard-deletes/reinserts every dish on
// every reparse — this is what stops a human correction from vanishing).
describe('matchVerifiedDishes', () => {
  it('matches by name + section when both are unchanged', () => {
    const verified = [{ name: 'Mushroom Risotto', sectionName: 'Mains' }];
    const candidates = [
      { id: 'a', name: 'Mushroom Risotto', sectionName: 'Mains' },
      { id: 'b', name: 'Mushroom Risotto', sectionName: 'Specials' },
    ];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([{ verifiedIndex: 0, matchId: 'a' }]);
  });

  it('falls back to a name-only match when the section was renamed', () => {
    const verified = [{ name: 'Mushroom Risotto', sectionName: 'Mains' }];
    const candidates = [{ id: 'a', name: 'Mushroom Risotto', sectionName: 'Chef Specials' }];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([{ verifiedIndex: 0, matchId: 'a' }]);
  });

  it('is case-insensitive and trims whitespace on both name and section', () => {
    const verified = [{ name: '  Mushroom Risotto ', sectionName: 'mains' }];
    const candidates = [{ id: 'a', name: 'mushroom risotto', sectionName: 'Mains' }];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([{ verifiedIndex: 0, matchId: 'a' }]);
  });

  it('reports no match (matchId: null) when the dish is absent from the new extraction — a deliberate admin add/correction that must be kept, not dropped', () => {
    const verified = [{ name: 'Chef Special Dumplings', sectionName: 'Mains' }];
    const candidates = [{ id: 'a', name: 'Mushroom Risotto', sectionName: 'Mains' }];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([{ verifiedIndex: 0, matchId: null }]);
  });

  it('handles unsectioned dishes (sectionName: null) consistently', () => {
    const verified = [{ name: 'Garlic Bread', sectionName: null }];
    const candidates = [
      { id: 'a', name: 'Garlic Bread', sectionName: 'Sides' },
      { id: 'b', name: 'Garlic Bread', sectionName: null },
    ];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([{ verifiedIndex: 0, matchId: 'b' }]);
  });

  it('preserves per-item results across multiple verified dishes, matched and unmatched', () => {
    const verified = [
      { name: 'Tofu Curry', sectionName: 'Mains' },
      { name: 'Ghost Dish', sectionName: 'Mains' },
    ];
    const candidates = [{ id: 'a', name: 'Tofu Curry', sectionName: 'Mains' }];
    const result = matchVerifiedDishes(verified, candidates);
    expect(result).toEqual([
      { verifiedIndex: 0, matchId: 'a' },
      { verifiedIndex: 1, matchId: null },
    ]);
  });
});
