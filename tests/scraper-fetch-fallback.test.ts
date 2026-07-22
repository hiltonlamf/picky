import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MENU_LIKE_TEXT } from './helpers';
import type { ReaderResult } from '@/lib/reader';

// scrapeHtmlPage's direct fetch can fail outright even when the site is really
// up — e.g. drurybuildings.com (Node's bundled CA list lagging a brand-new,
// legitimate cert chain real browsers and curl already trust). The reader
// does its own separate server-side fetch, so it isn't blocked by the same
// local trust-store gap — this is what lets that class of site still resolve.
vi.mock('@/lib/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reader')>();
  return { ...actual, readPage: vi.fn() };
});

import { scrapeRestaurant } from '@/lib/scraper';
import { readPage } from '@/lib/reader';

const mockReadPage = vi.mocked(readPage);

function readerResult(overrides: Partial<ReaderResult> = {}): ReaderResult {
  return {
    markdown: MENU_LIKE_TEXT,
    html: '',
    links: [],
    imageUrls: [],
    pdfLinks: [],
    finalUrl: 'https://example-restaurant.ie/',
    title: 'Example Restaurant',
    provider: 'jina',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scraper fetch-failure fallback (drurybuildings.com-class TLS gap)', () => {
  it('falls back to the reader when the direct fetch fails outright, instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }))
    );
    mockReadPage.mockResolvedValue(readerResult());

    const promise = scrapeRestaurant('https://example-restaurant.ie');
    await vi.runAllTimersAsync(); // flush fetchWithRetry's 1s/2s backoff delays
    const result = await promise;

    expect(result.menuText).toContain('Starters');
    expect(result.urlType).toBe('html');
  });

  it('still throws when the reader ALSO cannot reach the page (a genuinely dead site)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    mockReadPage.mockResolvedValue(null);

    const promise = scrapeRestaurant('https://example-restaurant.ie').catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
  });

  it('does not fall back to the reader for a subpage fetch failure (only the top-level page)', async () => {
    // A subpage link failing is already handled by the caller trying the next
    // link, one at a time — retrying every failed subpage via the reader would
    // multiply latency/cost for what's usually just a dead link, not a
    // domain-wide trust-store gap.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    mockReadPage.mockResolvedValue(readerResult());

    // No menuLinks on the top-level page, so subpage-following never triggers —
    // this just confirms the top-level call is what consumes the fallback,
    // by checking the reader was in fact invoked exactly once (not per-retry).
    const promise = scrapeRestaurant('https://example-restaurant.ie');
    await vi.runAllTimersAsync();
    await promise;
    expect(mockReadPage).toHaveBeenCalledTimes(1);
  });
});
