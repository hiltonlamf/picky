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

import { extractMenuResumable, type ExtractContext } from '@/lib/menu-extract';
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
});
