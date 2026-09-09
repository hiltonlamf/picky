import { describe, it, expect } from 'vitest';
import { shouldBootstrapGuide, seedingEnabled } from '@/lib/guide-bootstrap';

// Every case here is one of the three things that had to be true for the
// 2026-09-08 Dublin guide wipe. If any single one of them had been false, the
// guide would still have its ~70 restaurants.

describe('shouldBootstrapGuide', () => {
  it('re-seeds only a genuinely empty database', () => {
    const d = shouldBootstrapGuide({ guideCount: 0, analysedCount: 0 });
    expect(d.bootstrap).toBe(true);
  });

  it('leaves a curated guide alone', () => {
    expect(shouldBootstrapGuide({ guideCount: 79, analysedCount: 84 }).bootstrap).toBe(false);
    expect(shouldBootstrapGuide({ guideCount: 1, analysedCount: 1 }).bootstrap).toBe(false);
  });

  it('does NOT re-seed an emptied guide — the bug that lost the Dublin guide', () => {
    // The exact shape of the incident: the guide read as empty while 84
    // analysed Dublin restaurants sat in the database. That is a guide that
    // has been emptied, not a new one, and re-seeding four hardcoded
    // restaurants over it is how ~70 became 3.
    const d = shouldBootstrapGuide({ guideCount: 0, analysedCount: 84 });
    expect(d.bootstrap).toBe(false);
    expect(d.reason).toContain('emptied guide');
  });

  it('fails closed when a count cannot be read', () => {
    // The old code was `(guideCount ?? 0) === 0`, so ANY transient query
    // failure became "the guide is empty, re-seed it".
    expect(shouldBootstrapGuide({ guideCount: null, analysedCount: 0 }).bootstrap).toBe(false);
    expect(shouldBootstrapGuide({ guideCount: 0, analysedCount: null }).bootstrap).toBe(false);
    expect(shouldBootstrapGuide({ guideCount: null, analysedCount: null }).bootstrap).toBe(false);
  });

  it('always says why, so the decision is never silent', () => {
    for (const input of [
      { guideCount: 0, analysedCount: 0 },
      { guideCount: 0, analysedCount: 84 },
      { guideCount: 79, analysedCount: 84 },
      { guideCount: null, analysedCount: null },
    ]) {
      expect(shouldBootstrapGuide(input).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('seedingEnabled', () => {
  it('is off unless explicitly asked for', () => {
    expect(seedingEnabled({} as NodeJS.ProcessEnv).bootstrap).toBe(false);
    expect(seedingEnabled({ SEED_ON_BOOT: '0' } as never).bootstrap).toBe(false);
    expect(seedingEnabled({ SEED_ON_BOOT: 'true' } as never).bootstrap).toBe(false);
  });

  it('never runs from a preview deployment, even when the flag is on', () => {
    // Previews share the PRODUCTION database — there is no branch database — so
    // a preview boot was writing to live data. This is what made a pescatarian
    // UI branch capable of changing the real Dublin guide.
    expect(seedingEnabled({ SEED_ON_BOOT: '1', VERCEL_ENV: 'preview' } as never).bootstrap).toBe(false);
    expect(seedingEnabled({ SEED_ON_BOOT: '1', VERCEL_ENV: 'development' } as never).bootstrap).toBe(false);
  });

  it('allows production, and local runs that ask for it', () => {
    expect(seedingEnabled({ SEED_ON_BOOT: '1', VERCEL_ENV: 'production' } as never).bootstrap).toBe(true);
    // No VERCEL_ENV at all = a local machine, where the flag is the only gate.
    expect(seedingEnabled({ SEED_ON_BOOT: '1' } as never).bootstrap).toBe(true);
  });
});
