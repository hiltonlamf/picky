/**
 * The Sonnet escalation rung was 46% of all API spend and wasted 75% of it.
 *
 * Measured over 2026-07-25..08-08 ($9.85 total): 309 escalation calls cost
 * $4.51, and 235 of them returned under 100 output tokens — a median of 47,
 * i.e. an empty `{"sections":[]}`. Escalation re-runs the SAME source on a
 * pricier model, so when the earlier rungs retrieved nothing (menu behind a
 * popup or JS, or the site refused us) it re-reads the same absent bytes and
 * returns the same verdict. It genuinely does rescue the opposite case —
 * De Kas, Chez Max, Vintage Kitchen, Kicky's: pages whose text WAS there and
 * was parsed badly.
 *
 * These tests pin that split. They are the deterministic, $0 guard on a gate
 * whose failure mode (silently skipping a site we could have cracked) would
 * otherwise only show up as a thin menu on the live suite.
 */
import { describe, it, expect } from 'vitest';
import { shouldEscalate, type EscalationEvidence } from '@/lib/menu-extract';

/** Nothing has happened yet: no rung run, no bytes retrieved. */
const nothing: EscalationEvidence = {
  blocked: false,
  anyBilled: false,
  anyMalfunction: false,
  visualBilled: false,
  bestItems: 0,
  menuLikeInput: false,
};

const ev = (over: Partial<EscalationEvidence>): EscalationEvidence => ({ ...nothing, ...over });

describe('shouldEscalate — skips what cannot possibly be rescued', () => {
  it('does not escalate when the site refused us (founder error type 3)', () => {
    // Waterkant's view-only Drive file. Re-fetching with a pricier model gets
    // the same 403 — this is the clearest pure-waste case in the ledger.
    expect(shouldEscalate(ev({ blocked: true, visualBilled: true, bestItems: 3 }))).toBe(false);
  });

  it('does not escalate when nothing ever reached a model', () => {
    // e.g. a text candidate whose inlineText was under the 100-char floor, so
    // runPrimary returned null without calling the API. There is no input to
    // re-read; escalation would send the same nothing at 3x the price.
    expect(shouldEscalate(ev({ anyBilled: false }))).toBe(false);
  });

  it('does not escalate when the model read the page and it truly had no menu', () => {
    // The 75% case: billed, came back empty, nothing visual was read, and the
    // page text does not look like a menu. A JS shell or a cookie wall.
    expect(shouldEscalate(ev({ anyBilled: true }))).toBe(false);
  });
});

describe('shouldEscalate — keeps every case where content was retrieved', () => {
  it('escalates a thin parse (founder error type 2 — the classic rescue)', () => {
    // 1..6 dishes: below MIN_FOOD_ITEMS, so the ladder has not stopped, but
    // dishes were found — the tasting-menu-as-one-dish / multi-menu shape.
    expect(shouldEscalate(ev({ anyBilled: true, bestItems: 1 }))).toBe(true);
    expect(shouldEscalate(ev({ anyBilled: true, bestItems: 6 }))).toBe(true);
  });

  it('escalates when a billed call came back malformed rather than empty', () => {
    // Truncated or invalid JSON is a model malfunction, not a verdict about
    // the page. A stronger model plausibly recovers it.
    expect(shouldEscalate(ev({ anyBilled: true, anyMalfunction: true }))).toBe(true);
  });

  it('escalates when a PDF or photo was actually read', () => {
    // Deliberately generous: this protects every scanned PDF and menu-board
    // photo, where Sonnet's vision genuinely beats Haiku's. This is the clause
    // most likely to retain waste, which is why the run/skip decision is
    // logged — so it can be tightened against real data rather than guesses.
    expect(shouldEscalate(ev({ anyBilled: true, visualBilled: true }))).toBe(true);
  });

  it('escalates when the page text is price-dense but Haiku still saw nothing', () => {
    // textLooksLikeMenu says this is a real menu, so an empty result is far
    // more likely a parse failure than an absent menu.
    expect(shouldEscalate(ev({ anyBilled: true, menuLikeInput: true }))).toBe(true);
  });
});

describe('shouldEscalate — blocked and never-billed beat every positive signal', () => {
  // Ordering matters: these two skips are provably lossless (the same bytes,
  // or no bytes, reach the model either way), so they must win even when a
  // rescue signal is also present. A regression here would reintroduce the
  // single most wasteful path in the pipeline.
  it('blocked wins over a thin parse', () => {
    expect(shouldEscalate(ev({ blocked: true, anyBilled: true, bestItems: 5 }))).toBe(false);
  });

  it('never-billed wins over menu-like text', () => {
    expect(shouldEscalate(ev({ anyBilled: false, menuLikeInput: true, bestItems: 0 }))).toBe(false);
  });
});
