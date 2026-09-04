/**
 * Two candidates that fall back to the SAME source must cost one call, once.
 *
 * `attemptPlan`'s alternate-PDF / alternate-images / screenshot rungs close over
 * shared ExtractContext fields, so their arguments are byte-identical for every
 * candidate. On a multi-candidate site where the primaries fail, that was N
 * full-price reads of the same document. The fix memoises the in-flight attempt
 * per source key.
 *
 * The subtle half is the ledger. Only ONE call was made, so only one consumer
 * may book its cost — this is the single place where CLAUDE.md's "never drop
 * usage" rule inverts into "never double-count usage", and getting it wrong
 * would inflate the very number we make spend decisions from. Both properties
 * are asserted below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifiedMenu, MenuCandidate } from '@/types';

vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>();
  return { ...actual, classifyMenuFromPdf: vi.fn() };
});

import { extractCandidatesResumable, extractMenuResumable, mergePartialMenus, type ExtractContext } from '@/lib/menu-extract';
import { classifyMenuFromPdf } from '@/lib/ai';

const mockPdf = vi.mocked(classifyMenuFromPdf);

/** A menu too thin to satisfy isValid, so the ladder keeps walking past it. */
function thinMenu(): ClassifiedMenu {
  return {
    restaurantName: 'Test',
    language: 'English',
    cuisine: null,
    sections: [
      {
        name: 'Mains',
        menuLabel: null,
        dishes: [
          { name: 'Bean stew', description: null, price: '12', classification: 'vegan', confidence: 0.9, reason: 'beans' },
        ],
      },
    ],
  } as unknown as ClassifiedMenu;
}

function validMenu(): ClassifiedMenu {
  const menu = thinMenu();
  menu.sections[0].dishes = Array.from({ length: 5 }, (_, index) => ({
    name: `Dish ${index + 1}`,
    description: undefined,
    price: '12',
    classification: 'vegan',
    confidence: 0.9,
    reason: 'test',
  })) as typeof menu.sections[0]['dishes'];
  return menu;
}

const PDF = 'https://example.com/menu.pdf';

/** Context shared by both candidates, exactly as extractAndMerge builds it. */
function sharedCtx(): ExtractContext {
  return {
    title: 'Test',
    // No inline text, so the `text` primary returns null without an API call
    // and the ladder falls through to the shared alternate-PDF rung.
    inlineText: '',
    pdfUrls: [PDF],
    pageUrl: 'https://example.com',
    sharedAttempts: new Map(),
    escalationBudget: { remaining: 2 },
    anyCandidateValid: { value: false },
  };
}

describe('shared fallback rungs', () => {
  beforeEach(() => {
    mockPdf.mockReset();
    mockPdf.mockResolvedValue({
      menu: thinMenu(),
      usage: { model: 'claude-haiku-4-5-20251001', tokensIn: 1000, tokensOut: 500, costUsd: 0.01 },
    });
  });

  it('reads a shared PDF once even when two candidates both fall back to it', async () => {
    const ctx = sharedCtx();
    const a: MenuCandidate = { id: 'a', type: 'text', ref: '', label: 'Lunch', source: 'homepage' };
    const b: MenuCandidate = { id: 'b', type: 'text', ref: '', label: 'Dinner', source: 'homepage' };

    const [ra, rb] = await Promise.all([
      extractMenuResumable(a, ctx),
      extractMenuResumable(b, ctx),
    ]);

    // One document, one paid read — not one per candidate.
    expect(mockPdf).toHaveBeenCalledTimes(1);

    // ...and the cost is booked exactly once across the two results, so the
    // ledger reflects the single call that actually happened.
    const total = (ra.usage?.costUsd ?? 0) + (rb.usage?.costUsd ?? 0);
    expect(total).toBeCloseTo(0.01, 6);

    // Both candidates still get the menu content — dedup must not starve the
    // second candidate of the result it would otherwise have paid for.
    expect(ra.best?.menu.sections.length).toBeGreaterThan(0);
    expect(rb.best?.menu.sections.length).toBeGreaterThan(0);
  });

  it('does not share across different sources', async () => {
    const ctx = sharedCtx();
    const other: ExtractContext = { ...ctx, pdfUrls: ['https://example.com/other.pdf'] };
    const a: MenuCandidate = { id: 'a', type: 'text', ref: '', label: 'Lunch', source: 'homepage' };
    const b: MenuCandidate = { id: 'b', type: 'text', ref: '', label: 'Dinner', source: 'homepage' };

    await extractMenuResumable(a, ctx);
    await extractMenuResumable(b, other);

    // Different documents are different work — memoising on the URL must not
    // collapse two genuinely distinct menus into one.
    expect(mockPdf).toHaveBeenCalledTimes(2);
  });

  it('runs distinct pending candidates concurrently and preserves their order', async () => {
    let active = 0;
    let maxActive = 0;
    mockPdf.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return {
        menu: validMenu(),
        usage: { model: 'claude-haiku-4-5-20251001', tokensIn: 1000, tokensOut: 500, costUsd: 0.01 },
      };
    });

    const candidates: MenuCandidate[] = ['a', 'b', 'c'].map((id) => ({
      id,
      type: 'pdf',
      ref: `https://example.com/${id}.pdf`,
      label: id.toUpperCase(),
      source: 'homepage',
    }));
    const results = await extractCandidatesResumable(candidates, sharedCtx(), {}, Number.POSITIVE_INFINITY);

    expect(maxActive).toBe(3);
    expect(results.map((row) => row.candidate.id)).toEqual(['a', 'b', 'c']);
    expect(results.every((row) => row.result.nextIndex === null)).toBe(true);
  });

  it('publishes a finished candidate before slower siblings settle', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    mockPdf.mockImplementation(async (url: string) => {
      if (url.includes('/slow.pdf')) await slowGate;
      return {
        menu: validMenu(),
        usage: { model: 'claude-haiku-4-5-20251001', tokensIn: 1000, tokensOut: 500, costUsd: 0.01 },
      };
    });

    const candidates: MenuCandidate[] = [
      { id: 'slow', type: 'pdf', ref: 'https://example.com/slow.pdf', label: 'Dinner', source: 'homepage' },
      { id: 'fast', type: 'pdf', ref: 'https://example.com/fast.pdf', label: 'Lunch', source: 'homepage' },
    ];
    const published: string[] = [];
    const batch = extractCandidatesResumable(
      candidates,
      sharedCtx(),
      {},
      Number.POSITIVE_INFINITY,
      ({ candidate }) => { published.push(candidate.id); }
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(published).toEqual(['fast']);
    releaseSlow();
    await batch;
    expect(published).toEqual(['fast', 'slow']);
  });

  it('labels a lone progressive menu so it stays selected when siblings arrive', () => {
    const partial = mergePartialMenus([{ label: 'Lunch', menu: validMenu() }]);
    expect(partial.sections.every((section) => section.menuLabel === 'Lunch')).toBe(true);

    const internallyNamed = validMenu();
    internallyNamed.sections[0].menuLabel = 'Tasting';
    const preserved = mergePartialMenus([{ label: 'Our menus', menu: internallyNamed }]);
    expect(preserved.sections[0].menuLabel).toBe('Tasting');
  });
});
