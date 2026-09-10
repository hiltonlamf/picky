import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_GUIDE_DISHES, heldBackReason, isPubliclyVisible } from '@/lib/review-flags';
import type { Dish, MenuSection, Restaurant } from '@/types';

/**
 * `heldBackReason` is the counterpart to `isPubliclyVisible`: that decides
 * whether a curated restaurant appears on its guide, this explains why not.
 *
 * It existed as two copies — the guide page's admin preview banner and the
 * guide workspace — which had already drifted in wording and in whether they
 * returned null. That matters more than it sounds: a guide showing 25 of 40 is
 * either a content gap or a pipeline bug, and this reason is the only thing
 * that tells them apart. It should not depend on which screen you are on.
 */

let seq = 0;

function dish(name: string, price = '€18.00'): Dish {
  return {
    id: `d${seq++}`, name, description: null, price, classification: 'vegetarian',
    confidence: 0.9, reportCount: 0, warningFlagged: false, humanVerified: false, origin: 'ai',
  } as unknown as Dish;
}

function section(name: string, dishes: Dish[]): MenuSection {
  return { id: `s${seq++}`, name, displayOrder: 0, menuLabel: null, dishes };
}

function restaurant(
  status: string,
  dishCount: number,
  extra: { guideApprovedAt?: string | null; sectionName?: string; firstDishName?: string } = {}
): Restaurant {
  const dishes = Array.from({ length: dishCount }, (_, i) => dish(`Dish ${i}`));
  if (extra.firstDishName && dishes.length) dishes[0] = dish(extra.firstDishName);
  return {
    status,
    guideApprovedAt: extra.guideApprovedAt ?? null,
    sections: dishCount ? [section(extra.sectionName ?? 'Mains', dishes)] : [],
  } as unknown as Restaurant;
}

describe('heldBackReason', () => {
  it('returns null for a restaurant that is actually showing', () => {
    const ok = restaurant('done', MIN_GUIDE_DISHES + 3);
    expect(isPubliclyVisible(ok)).toBe(true);
    expect(heldBackReason(ok)).toBeNull();
  });

  it('does not claim a never-started restaurant is being analysed', () => {
    // The batch runs in the admin's browser tab. Once that tab is gone nothing
    // is running, so "still analyzing" on a pending row sent the founder away
    // to wait for hours on work that was never going to happen.
    const reason = heldBackReason(restaurant('pending', 0));
    expect(reason).not.toMatch(/analysing|analyzing/i);
    expect(reason).toMatch(/not analysed yet/i);
    expect(reason).toMatch(/nothing is running/i);
  });

  it('distinguishes an interrupted run from one that never started', () => {
    const pending = heldBackReason(restaurant('pending', 0));
    const processing = heldBackReason(restaurant('processing', 0));
    expect(processing).not.toBe(pending);
    expect(processing).toMatch(/interrupted/i);
  });

  it('distinguishes an error from a site with no menu', () => {
    expect(heldBackReason(restaurant('error', 0))).toMatch(/errored/);
    expect(heldBackReason(restaurant('no_menu', 0))).toMatch(/no menu found/);
  });

  it('reports a thin menu with the real dish count', () => {
    expect(heldBackReason(restaurant('done', 2))).toBe('only 2 dishes — likely mis-read');
  });

  it('gets the singular right for a one-dish restaurant', () => {
    // "1 dishes" is exactly the sort of detail that reads as unfinished.
    expect(heldBackReason(restaurant('done', 1))).toBe('only 1 dish — likely mis-read');
  });

  it('surfaces a review flag in its own words', () => {
    // A tasting menu captured as a single "dish" — plausible-looking but wrong.
    const flagged = restaurant('done', MIN_GUIDE_DISHES + 1, {
      sectionName: 'Tasting Menu',
      firstDishName: 'Tasting Menu',
    });
    const reason = heldBackReason(flagged);
    if (isPubliclyVisible(flagged)) {
      expect(reason).toBeNull();
    } else {
      expect(reason).toBeTruthy();
      // Not the generic catch-all — the flag should explain itself.
      expect(reason).not.toBe('held back for review');
    }
  });

  it('respects a human approval that overrides the flags', () => {
    const approved = restaurant('done', MIN_GUIDE_DISHES + 1, {
      guideApprovedAt: '2026-09-01T00:00:00Z',
      sectionName: 'Tasting Menu',
      firstDishName: 'Tasting Menu',
    });
    expect(heldBackReason(approved)).toBeNull();
  });

  it('always agrees with isPubliclyVisible about whether something shows', () => {
    const cases = [
      restaurant('done', MIN_GUIDE_DISHES + 3),
      restaurant('done', 2),
      restaurant('done', 0),
      restaurant('error', 0),
      restaurant('no_menu', 0),
      restaurant('pending', 0),
      restaurant('processing', 0),
      restaurant('done', MIN_GUIDE_DISHES + 1, { guideApprovedAt: '2026-09-01T00:00:00Z' }),
    ];
    for (const r of cases) {
      expect(heldBackReason(r) === null).toBe(isPubliclyVisible(r));
    }
  });
});

describe('no page re-declares its own copy', () => {
  // The whole point of extracting it. A second copy drifts, and then the guide
  // page and the admin workspace disagree about why the same restaurant is
  // missing.
  it.each([
    'app/[city]/page.tsx',
    'app/admin/guides/[slug]/page.tsx',
  ])('%s imports heldBackReason instead of defining it', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).not.toContain('function heldBackReason');
    expect(source).toContain("from '@/lib/review-flags'");
    expect(source).toContain('heldBackReason');
  });
});
