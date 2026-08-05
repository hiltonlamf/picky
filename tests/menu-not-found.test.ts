/**
 * Regression tests for the "No menu listed on this site" cluster reported
 * 2026-08-05: six restaurants whose menu a human finds in a couple of clicks.
 *
 * Each block names the real site it came from, so a future change that breaks
 * one of these fails with the restaurant's name attached rather than an
 * abstract assertion. All free: fixtures and mocked network, no AI, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cheerio from 'cheerio';
import {
  findEnglishVariant,
  findMenuLinks,
  findNavLinks,
  looksEnglish,
  isSamePage,
} from '@/lib/scraper';
import { resolveDocumentUrl, documentUrlCandidates, googleDriveFileId } from '@/lib/doc-url';
import { looksLikePdf, AICallError, driveConfirmUrl, MenuAccessBlockedError } from '@/lib/ai';
import {
  readerResultIsThin,
  readPage,
  jinaStatus,
  resetJinaCircuit,
  clearPageCache,
  pageCacheSize,
  DOCUMENT_TIMEOUT_MS,
} from '@/lib/reader';
import { sumUsage, BLOCKED_MENU_MESSAGE, ExtractionError } from '@/lib/menu-extract';
import { isNonFoodMenu } from '@/lib/menu-discovery';

describe('Google Drive / Dropbox menu links (waterkantamsterdam.nl)', () => {
  it('rewrites a Drive share link to a direct download', () => {
    // Preferred form is the post-consent endpoint: the plain uc?export=download
    // hands back a virus-scan interstitial for anything sizeable, which is what
    // actually defeated this restaurant. Both are still tried, in order.
    expect(
      resolveDocumentUrl('https://drive.google.com/file/d/1XhR71TLkaDiQuR5pvMH3x8oGBYJ7B-tj/view?usp=sharing')
    ).toBe(
      'https://drive.usercontent.google.com/download?id=1XhR71TLkaDiQuR5pvMH3x8oGBYJ7B-tj&export=download&confirm=t'
    );
  });

  it('handles the /preview form and the ?id= form', () => {
    expect(resolveDocumentUrl('https://drive.google.com/file/d/ABC123/preview')).toContain('id=ABC123');
    expect(resolveDocumentUrl('https://drive.google.com/open?id=XYZ789')).toContain('id=XYZ789');
  });

  it('forces a Dropbox share link to download', () => {
    expect(resolveDocumentUrl('https://www.dropbox.com/s/abc/menu.pdf?dl=0')).toContain('dl=1');
  });

  it('leaves an ordinary PDF URL alone', () => {
    const url = 'https://example-restaurant.ie/menus/dinner.pdf';
    expect(resolveDocumentUrl(url)).toBe(url);
  });

  it('never throws on a malformed URL', () => {
    expect(resolveDocumentUrl('not a url')).toBe('not a url');
  });
});

describe('a "PDF" that is really an HTML viewer page', () => {
  const bytesOf = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

  it('recognises a real PDF', () => {
    expect(looksLikePdf(bytesOf('%PDF-1.7\n'))).toBe(true);
  });

  it('rejects an HTML page — this is what stops us paying for a doomed call', () => {
    expect(looksLikePdf(bytesOf('<!DOCTYPE html><html>'))).toBe(false);
  });

  it('rejects truncated/empty responses', () => {
    expect(looksLikePdf(new Uint8Array([]))).toBe(false);
    expect(looksLikePdf(bytesOf('%PD'))).toBe(false);
  });
});

describe('English-version detection', () => {
  it('follows an "ENG" switcher (restaurantdekas.com)', () => {
    const $ = cheerio.load(`
      <html lang="nl-NL"><body>
        <a href="/nl/tuin">NL</a><a href="/eng/garden">ENG</a>
      </body></html>
    `);
    expect(findEnglishVariant($, 'https://restaurantdekas.com/')).toBe('https://restaurantdekas.com/eng/garden');
  });

  it('follows a bare flag image with no text (newking.nl)', () => {
    const $ = cheerio.load(`
      <html lang="nl-NL"><body>
        <a href="/en/"><img src="/wp-content/plugins/sitepress/res/flags/gb.png"></a>
        <a href="/zh-hans/"><img src="/wp-content/plugins/sitepress/res/flags/zh.png"></a>
      </body></html>
    `);
    expect(findEnglishVariant($, 'https://newking.nl/')).toBe('https://newking.nl/en/');
  });

  it('switches when the page LIES about being English (Squarespace lang="en-US", Dutch body)', () => {
    const dutch = 'Wij serveren gerechten uit onze eigen kas met groenten van het land. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="en-US"><body><p>${dutch}</p><a href="/eng/menu">English</a></body></html>
    `);
    expect(findEnglishVariant($, 'https://example.nl/')).toBe('https://example.nl/eng/menu');
  });

  it('does NOT switch on a genuinely English page (no wasted fetch)', () => {
    const english = 'We serve seasonal dishes from our own garden with vegetables that are grown here. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="en"><body><p>${english}</p><a href="/en/menu">English</a></body></html>
    `);
    expect(findEnglishVariant($, 'https://example.com/')).toBeNull();
  });

  it('does not mistake /enoteca for an English path', () => {
    const dutch = 'Onze keuken werkt met verse producten van het seizoen en lokale telers. '.repeat(12);
    const $ = cheerio.load(`<html lang="nl"><body><p>${dutch}</p><a href="/enoteca">Enoteca</a></body></html>`);
    expect(findEnglishVariant($, 'https://example.nl/')).toBeNull();
  });

  it('prefers the standard hreflang alternate when present', () => {
    const $ = cheerio.load(`
      <html lang="nl"><head>
        <link rel="alternate" hreflang="en" href="https://example.nl/en/">
      </head><body><a href="/eng/">ENG</a></body></html>
    `);
    expect(findEnglishVariant($, 'https://example.nl/')).toBe('https://example.nl/en/');
  });
});

describe('looksEnglish', () => {
  it('recognises English restaurant copy', () => {
    expect(looksEnglish('We serve the freshest dishes from our garden with vegetables that are grown for you. '.repeat(6))).toBe(true);
  });

  it('rejects Dutch copy', () => {
    expect(looksEnglish('Wij serveren gerechten uit onze eigen kas met groenten van het seizoen. '.repeat(8))).toBe(false);
  });

  it('answers "English" on too little text, so a thin page never triggers a switch', () => {
    expect(looksEnglish('Welkom')).toBe(true);
  });
});

describe('same-page jump links are not separate menus (newking.nl)', () => {
  it('drops #fragment links pointing at the page we are already on', () => {
    const $ = cheerio.load(`
      <a href="/en/#menuarea">Menu</a>
      <a href="/en/#chicken-dishes">Chicken dishes</a>
      <a href="/en/menu-lunch">Lunch menu</a>
    `);
    const { htmlLinks } = findMenuLinks($, 'https://newking.nl/en/');
    expect(htmlLinks).toEqual(['https://newking.nl/en/menu-lunch']);
  });

  it('keeps a fragment link that points at a DIFFERENT page', () => {
    const $ = cheerio.load(`<a href="/menus#lunch">Lunch menu</a>`);
    const { htmlLinks } = findMenuLinks($, 'https://example.com/');
    expect(htmlLinks).toEqual(['https://example.com/menus#lunch']);
  });

  it('keeps same-page anchors out of nav links too', () => {
    const $ = cheerio.load(`<a href="/en/#ourlocation">Location</a><a href="/en/dining">Dining</a>`);
    expect(findNavLinks($, 'https://newking.nl/en/')).toEqual(['https://newking.nl/en/dining']);
  });

  it('isSamePage ignores fragments and trailing slashes', () => {
    expect(isSamePage('https://a.com/x/#y', 'https://a.com/x')).toBe(true);
    expect(isSamePage('https://a.com/x', 'https://a.com/z')).toBe(false);
  });
});

describe('reader quality gate (when to pay for Firecrawl)', () => {
  const base = {
    markdown: '',
    html: '',
    links: [] as string[],
    imageUrls: [] as string[],
    pdfLinks: [] as string[],
    finalUrl: 'https://example.com',
    title: '',
    provider: 'jina' as const,
  };

  it('treats a near-empty render as thin — the JS-only-site failure', () => {
    expect(readerResultIsThin({ ...base, markdown: 'Home Menu Contact', links: ['https://example.com/'] })).toBe(true);
  });

  it('does not pay again when a menu source was already found', () => {
    expect(readerResultIsThin({ ...base, markdown: 'Home', pdfLinks: ['https://example.com/menu.pdf'] })).toBe(false);
  });

  it('does not pay again for a substantive read', () => {
    expect(readerResultIsThin({ ...base, markdown: 'x'.repeat(1200) })).toBe(false);
  });
});

describe('a dead or unfunded Jina key is not retried on every page', () => {
  beforeEach(() => {
    resetJinaCircuit();
    // These cases reuse URLs across tests, and readPage now caches by URL —
    // without this, a later test reads the earlier test's cached null and
    // never exercises the provider at all.
    clearPageCache();
    vi.unstubAllGlobals();
  });

  it('opens the circuit on 402 (out of credit) and stops calling Jina', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({}),
      text: async () => 'insufficient balance',
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await readPage('https://a.example/1')).toBeNull();
    expect(await readPage('https://a.example/2')).toBeNull();
    expect(await readPage('https://a.example/3')).toBeNull();

    // One attempt total, not one per page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jinaStatus()).toContain('402');
    expect(jinaStatus()).toContain('out of credit');
  });

  it('names a keyless 403 as the Cloudflare challenge it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}), text: async () => 'Just a moment...' })
    );
    await readPage('https://a.example/1');
    expect(jinaStatus()).toContain('Cloudflare challenge');
  });

  it('does NOT open the circuit on 429 — rate limiting is transient', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', fetchMock);
    // Fake timers: the 429 path deliberately sleeps 12s before its one retry.
    vi.useFakeTimers();
    try {
      const pending = readPage('https://a.example/1');
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(jinaStatus()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + the backoff retry
  });
});

describe('a locale in a third-party URL is not a translation (waterkantamsterdam.nl)', () => {
  it('ignores an off-site booking widget whose path contains /en/', () => {
    // Firecrawl surfaces embedded widgets that raw HTML hid. Waterkant embeds
    // widget.formitable.com/side/en/<id>/book — matching the English-path rule
    // sent the whole pipeline to a reservation form instead of the menu.
    const dutch = 'Wij serveren gerechten met verse producten van het seizoen en lokale telers. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="nl"><body>
        <p>${dutch}</p>
        <a href="https://widget.formitable.com/side/en/ef993c47/book?tag=Website">Book a table</a>
      </body></html>
    `);
    expect(findEnglishVariant($, 'https://www.waterkantamsterdam.nl/')).toBeNull();
  });

  it('still follows a same-site English path', () => {
    const dutch = 'Wij serveren gerechten met verse producten van het seizoen en lokale telers. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="nl"><body><p>${dutch}</p><a href="/en/menu">EN</a></body></html>
    `);
    expect(findEnglishVariant($, 'https://www.waterkantamsterdam.nl/')).toBe('https://www.waterkantamsterdam.nl/en/menu');
  });

  it('allows a different subdomain of the same site', () => {
    const dutch = 'Wij serveren gerechten met verse producten van het seizoen en lokale telers. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="nl"><body><p>${dutch}</p><a href="https://en.example.nl/">English</a></body></html>
    `);
    expect(findEnglishVariant($, 'https://www.example.nl/')).toBe('https://en.example.nl/');
  });

  it('ignores an off-site hreflang alternate too', () => {
    const dutch = 'Wij serveren gerechten met verse producten van het seizoen en lokale telers. '.repeat(12);
    const $ = cheerio.load(`
      <html lang="nl"><head>
        <link rel="alternate" hreflang="en" href="https://someaggregator.com/nl/restaurant/en">
      </head><body><p>${dutch}</p></body></html>
    `);
    expect(findEnglishVariant($, 'https://example.nl/')).toBeNull();
  });
});

describe('Google Drive virus-scan interstitial (waterkantamsterdam.nl, round 2)', () => {
  it('offers the confirm-token endpoint FIRST, then the plain uc download', () => {
    const urls = documentUrlCandidates('https://drive.google.com/file/d/FILEID/view?usp=sharing');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://drive.usercontent.google.com/download?id=FILEID&export=download&confirm=t');
    expect(urls[1]).toBe('https://drive.google.com/uc?export=download&id=FILEID');
  });

  it('extracts the id from the ?id= form too', () => {
    expect(documentUrlCandidates('https://drive.google.com/open?id=ABC')[0]).toContain('id=ABC');
  });

  it('leaves a normal PDF as a single candidate', () => {
    expect(documentUrlCandidates('https://x.ie/menu.pdf')).toEqual(['https://x.ie/menu.pdf']);
  });

  it('googleDriveFileId returns null for non-Drive URLs', () => {
    expect(googleDriveFileId('https://x.ie/menu.pdf')).toBeNull();
  });
});

describe('a billed-but-unusable call must not report $0 (run #33 undercount)', () => {
  it('AICallError carries the usage of the call that was already charged', () => {
    const usage = { model: 'claude-haiku-4-5-20251001', tokensIn: 5000, tokensOut: 8192, costUsd: 0.0459 };
    const err = new AICallError('AI returned invalid JSON.', usage);
    expect(err.usage).toEqual(usage);
    expect(err.truncated).toBe(false);
  });

  it('flags truncation separately, so the caller can split rather than give up', () => {
    const err = new AICallError('hit the output limit', { model: 'm', tokensIn: 1, tokensOut: 2, costUsd: 0.5 }, true);
    expect(err.truncated).toBe(true);
  });

  it('sumUsage adds a failed attempt cost into the running total', () => {
    const a = { model: 'haiku', tokensIn: 100, tokensOut: 50, costUsd: 0.01 };
    const b = { model: 'haiku', tokensIn: 200, tokensOut: 80, costUsd: 0.02 };
    const total = sumUsage(a, b);
    expect(total.costUsd).toBeCloseTo(0.03);
    expect(total.tokensIn).toBe(300);
  });
});

describe('Google Drive confirm form (waterkantamsterdam.nl, round 3)', () => {
  it('rebuilds the download URL from the confirm page, uuid and all', () => {
    // The token is generated per request, which is why a fixed confirm=t fails.
    const html = `<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="1XhR71TLkaDi">
      <input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="abc-123-def">
    </form></body></html>`;
    const url = driveConfirmUrl(html);
    expect(url).toContain('https://drive.usercontent.google.com/download?');
    expect(url).toContain('id=1XhR71TLkaDi');
    expect(url).toContain('uuid=abc-123-def');
    expect(url).toContain('confirm=t');
  });

  it('returns null for a page that is not a Drive confirm form', () => {
    expect(driveConfirmUrl('<html><body>Sorry, file not found</body></html>')).toBeNull();
    expect(driveConfirmUrl('<form action="https://evil.example/steal"><input type="hidden" name="id" value="x"></form>')).toBeNull();
  });

  it('returns null when the form carries no file id', () => {
    expect(driveConfirmUrl('<form action="https://drive.google.com/x"><input type="hidden" name="uuid" value="q"></form>')).toBeNull();
  });
});

describe('private-dining packs are not the restaurant menu (linastores.co.uk)', () => {
  it('drops a "PDR Combined" brochure', () => {
    expect(isNonFoodMenu('PDR Combined (1)')).toBe(true);
    expect(isNonFoodMenu('Private Dining and Events')).toBe(true);
  });

  it('still keeps ordinary food menus', () => {
    expect(isNonFoodMenu('Dinner Menu')).toBe(false);
    expect(isNonFoodMenu('A La Carte')).toBe(false);
    expect(isNonFoodMenu('Lunch')).toBe(false);
  });
});

describe('page cache — the same page is never fetched twice in one analysis', () => {
  beforeEach(() => {
    clearPageCache();
    resetJinaCircuit();
    vi.unstubAllGlobals();
  });

  it('serves a repeat read from cache instead of paying again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { content: 'x'.repeat(2000), url: 'https://a.example/menus', links: [], images: [] } }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    // Discovery reads /menus, then extraction reads it again seconds later.
    const first = await readPage('https://a.example/menus');
    const second = await readPage('https://a.example/menus');

    expect(first?.markdown).toBe(second?.markdown);
    expect(fetchMock).toHaveBeenCalledTimes(1); // paid once, used twice
    expect(pageCacheSize()).toBe(1);
  });

  it('still fetches a DIFFERENT page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { content: 'y'.repeat(2000), url: 'https://a.example/x', links: [], images: [] } }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    await readPage('https://a.example/one');
    await readPage('https://a.example/two');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a failure too — a page that refused once will refuse again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await readPage('https://dead.example/')).toBeNull();
    expect(await readPage('https://dead.example/')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a cached failure when the caller asks for a LONGER budget', async () => {
    // tofuvegan.com in one test: the 26 MB menu PDF times out on the ordinary
    // 25s page budget, and the document path then asks for 90s. Serving it the
    // earlier null would cache the exact bug the longer budget exists to fix.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('The operation was aborted due to timeout');
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { content: 'z'.repeat(2000), url: 'https://slow.example/menu.pdf', links: [], images: [] } }),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await readPage('https://slow.example/menu.pdf')).toBeNull();
    const retried = await readPage('https://slow.example/menu.pdf', DOCUMENT_TIMEOUT_MS);
    expect(retried?.markdown.length).toBeGreaterThan(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-fetch a cached failure for an equal or shorter budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await readPage('https://dead2.example/', DOCUMENT_TIMEOUT_MS)).toBeNull();
    expect(await readPage('https://dead2.example/')).toBeNull(); // shorter — no point retrying
    expect(await readPage('https://dead2.example/', DOCUMENT_TIMEOUT_MS)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a cached SUCCESS to any budget — success is success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { content: 'w'.repeat(2000), url: 'https://ok.example/', links: [], images: [] } }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    await readPage('https://ok.example/');
    await readPage('https://ok.example/', DOCUMENT_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('"we were refused" is not "there is no menu" (waterkantamsterdam.nl)', () => {
  it('recognises the Drive owner-restricted page as a refusal', () => {
    // Verbatim from run #36's log.
    const html =
      '<html><body>Google Drive - Can&#39;t download file Sorry, the owner hasn&#39;t given you ' +
      'permission to download this file. Only the owner and editors can download this file.</body></html>';
    expect(looksLikePdf(new Uint8Array(Buffer.from(html, 'utf8')))).toBe(false);
    // The wording the detector keys on survives entity-unescaping.
    expect(/hasn't given you permission|only the owner and editors/i.test(html.replace(/&#39;/g, "'"))).toBe(true);
  });

  it('carries a reason a human can act on', () => {
    const err = new MenuAccessBlockedError('the file owner has restricted downloads');
    expect(err.detail).toContain('restricted downloads');
    expect(err.name).toBe('MenuAccessBlockedError');
  });

  it('the blocked message asks for help instead of blaming the restaurant', () => {
    // The distinction the founder asked for: our limitation, stated plainly.
    expect(BLOCKED_MENU_MESSAGE).toMatch(/AI agents/i);
    expect(BLOCKED_MENU_MESSAGE).toMatch(/give us a hand/i);
    // It must NOT claim the restaurant has no menu — that would be false.
    expect(BLOCKED_MENU_MESSAGE).not.toMatch(/may not publish|doesn't publish|no menu/i);
  });

  it('ExtractionError carries the blocked flag so routes can branch on it', () => {
    const blocked = new ExtractionError(BLOCKED_MENU_MESSAGE, undefined, true);
    expect(blocked.blocked).toBe(true);
    expect(new ExtractionError('ordinary failure').blocked).toBe(false);
  });
});
