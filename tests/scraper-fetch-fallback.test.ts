import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MENU_LIKE_TEXT } from './helpers';
import type { ReaderResult } from '@/lib/reader';

// scrapeHtmlPage's direct fetch can fail outright even when the site is really
// up — e.g. drurybuildings.com (Node's bundled CA list lagging a brand-new,
// legitimate cert chain real browsers and curl already trust). The reader
// does its own separate server-side fetch, so it isn't blocked by the same
// local trust-store gap — this is what lets that class of site still resolve.
// The SSRF guard (lib/url-guard) resolves DNS before every outbound fetch.
// That is real network I/O, which vi.useFakeTimers() cannot coordinate with —
// runAllTimersAsync() returns before the lookup settles, so the retry backoff
// never advances and the test times out. Resolve to a public address instead:
// these tests are about the reader fallback, not about the guard, which has
// its own coverage in tests/url-guard.test.ts. A plain function (not vi.fn)
// so beforeEach's resetAllMocks cannot strip the implementation.
vi.mock('@/lib/dns-lookup', () => ({
  dnsLookupAll: async () => [{ address: '93.184.216.34' }],
}));

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

/** A fetch stub that serves canned HTML per URL. */
function htmlResponse(body: string, init: { ok?: boolean; status?: number; url?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    url: init.url ?? 'https://example-restaurant.ie/',
    text: async () => body,
  };
}

describe('menu text hidden in tabs and overlays (newking.nl, linastores.co.uk)', () => {
  it('reads dishes out of aria-hidden tab panels instead of discarding them', async () => {
    // A tabbed menu keeps every panel but the active one aria-hidden. Stripping
    // those threw the whole menu away and reported "no menu listed on this site".
    const page = `
      <html lang="en"><body>
        <div role="tabpanel">Starters — Spring rolls €6.50, Wonton soup €7.00</div>
        <div role="tabpanel" aria-hidden="true">
          Mains — Kung Pao chicken €16.50, Mapo tofu €14.00, Beef chow fun €17.00,
          Sweet and sour pork €16.00, Salt and pepper squid €18.00
        </div>
        <div role="tabpanel" aria-hidden="true">Desserts — Mango pudding €6.00</div>
      </body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(page)));
    mockReadPage.mockResolvedValue(null);

    const promise = scrapeRestaurant('https://example-restaurant.ie');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.menuText).toContain('Mapo tofu');
    expect(result.menuText).toContain('Mango pudding');
  });
});

describe('a "Menus" page that is only buttons (neni-amsterdam.nl, tofuvegan.com)', () => {
  it('harvests the PDFs from a menu index page with almost no text of its own', async () => {
    const home = `<html lang="en"><body><a href="/menus">Menus</a><p>Welcome to our restaurant.</p></body></html>`;
    // Under 200 chars of text — the old length gate skipped pages like this
    // outright, losing every PDF linked from them.
    const menus = `<html lang="en"><body>
        <a href="https://my.pocketmenu.nl/uploads/neni/a-la-carte.pdf">A la Carte Menu</a>
        <a href="https://my.pocketmenu.nl/uploads/neni/sharing.pdf">Sharing Menus</a>
      </body></html>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) =>
        String(url).includes('/menus')
          ? htmlResponse(menus, { url: 'https://example-restaurant.ie/menus' })
          : htmlResponse(home)
      )
    );
    mockReadPage.mockResolvedValue(null);

    const promise = scrapeRestaurant('https://example-restaurant.ie');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.menuPdfUrls).toContain('https://my.pocketmenu.nl/uploads/neni/a-la-carte.pdf');
    expect(result.menuPdfUrls).toContain('https://my.pocketmenu.nl/uploads/neni/sharing.pdf');
  });
});

describe('HTTP error pages are not the restaurant (Cloudflare / 404)', () => {
  it('does not treat a 403 challenge page as site content', async () => {
    const challenge = `<html><body>Just a moment... Enable JavaScript and cookies to continue. ${'Checking your browser. '.repeat(30)}</body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(challenge, { ok: false, status: 403 })));
    mockReadPage.mockResolvedValue(null);

    const promise = scrapeRestaurant('https://example-restaurant.ie').catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await promise;

    // Either it throws (nothing readable) or it returns no menu text — what it
    // must NEVER do is present the challenge text as the restaurant's page.
    if (result instanceof Error) expect(result.message).toBeTruthy();
    else expect(result.menuText).not.toContain('Checking your browser');
  });

  it('uses the reader when our own fetch is blocked but the page is really up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse('blocked', { ok: false, status: 403 })));
    mockReadPage.mockResolvedValue(readerResult());

    const promise = scrapeRestaurant('https://example-restaurant.ie');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.menuText).toContain('Starters');
  });
});
