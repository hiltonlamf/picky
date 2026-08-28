import { assertPublicUrl } from './url-guard';
/**
 * Provider-abstracted page reader.
 *
 * Acquires a URL's content with JavaScript rendering via an external reader API
 * so that JS-heavy sites (Weebly/Wix/Squarespace) and lazy-loaded menus are
 * captured. Always degrades gracefully: on a missing key or any error it returns
 * `null` so callers fall back to the existing cheerio path. Never throws.
 *
 * Provider selection:
 *   - READER_PROVIDER=firecrawl  → Firecrawl only (needs FIRECRAWL_API_KEY)
 *   - READER_PROVIDER=jina       → Jina Reader only (needs JINA_API_KEY)
 *   - READER_PROVIDER=off        → disabled (cheerio only)
 *   - unset → Jina first when a key is present, Firecrawl as the FALLBACK when
 *     Jina returns nothing useful (founder's call, 2026-08-05: pay per hard
 *     page, not per page).
 *
 * Why this order: a keyed Jina is cheap per page but gives up on some JS-heavy
 * ones; Firecrawl is reliable but billed. Trying the cheap one first and
 * escalating only on a genuinely poor result means the paid provider handles
 * the sites that actually need it — exactly the set where our "no menu listed"
 * bug lives.
 *
 * STATE AS OF 2026-08-06: there is no funded Jina key, so in practice this is
 * Firecrawl-only. `readWithJina` returns immediately without a key rather than
 * spending a round-trip on Jina's guaranteed Cloudflare 403 — the keyless free
 * tier no longer exists. Nothing else changes: add a funded JINA_API_KEY and
 * the cheap-first ladder comes back on its own.
 */

import * as Sentry from '@sentry/nextjs';
import { clampTimeout } from './deadline';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Default per-provider request budget. Generous enough for a JS-heavy page,
 *  short enough that an analysis doesn't stall on one dead host. */
const READER_TIMEOUT_MS = 25000;
/** Big documents need longer. tofuvegan.com's menu is a 26 MB PDF: it downloads
 *  fine, but 25s was not enough for the reader to fetch and extract it, so the
 *  restaurant looked menu-less purely because we gave up too early. Only the
 *  document path pays this; ordinary pages keep the short budget. */
export const DOCUMENT_TIMEOUT_MS = 90000;

/**
 * A dead reader is invisible from the outside: every provider swallows its own
 * errors and returns null, callers fall back to raw HTML, and the app confidently
 * reports "no menu listed on this site" for restaurants that plainly have one.
 * That is exactly what happened — r.jina.ai began answering keyless requests with
 * a Cloudflare challenge and nothing anywhere said so (found 2026-08-05).
 *
 * So: report it. Once per process, not per page — a total outage would otherwise
 * fire thousands of identical events and get itself rate-limited into silence.
 */
let readerOutageReported = false;

function reportReaderOutage(url: string): void {
  if (readerOutageReported) return;
  readerOutageReported = true;
  const detail =
    `No reader provider could render a page (first seen: ${url}). ` +
    `JS-rendered restaurant sites will be read as raw HTML and will look like they have no menu. ` +
    `Jina key: ${process.env.JINA_API_KEY ? 'set' : 'MISSING'}` +
    `${jinaDisabledReason ? ` (disabled: ${jinaDisabledReason})` : ''}, ` +
    `Firecrawl key: ${process.env.FIRECRAWL_API_KEY ? 'set' : 'MISSING'}` +
    `${firecrawlDisabledReason ? ` (disabled: ${firecrawlDisabledReason})` : ''}.`;
  console.error('[reader]', detail);
  Sentry.captureException(new Error(`Reader outage: ${detail}`), {
    tags: { area: 'reader' },
    level: 'error',
  });
}

export interface ReaderResult {
  markdown: string; // clean rendered text content
  html: string; // rawHtml for cheerio link/image extraction (may be empty)
  links: string[]; // absolute hrefs the renderer found
  imageUrls: string[];
  pdfLinks: string[];
  screenshotUrl?: string; // hosted full-page screenshot (Firecrawl) for vision fallback
  finalUrl: string;
  title: string;
  provider: 'firecrawl' | 'jina';
}

type Provider = 'firecrawl' | 'jina' | 'off' | 'auto';

function selectProvider(): Provider {
  const explicit = (process.env.READER_PROVIDER ?? '').toLowerCase().trim();
  if (explicit === 'off') return 'off';
  if (explicit === 'firecrawl') return 'firecrawl';
  if (explicit === 'jina') return 'jina';
  return 'auto';
}

/** Whether a JS-rendering reader is available (i.e. not disabled). */
export function isReaderEnabled(): boolean {
  return selectProvider() !== 'off';
}

/** Whether the paid fallback is actually available (key present). */
export function isFirecrawlConfigured(): boolean {
  return !!process.env.FIRECRAWL_API_KEY;
}

/**
 * Is this read good enough to stop, or should we pay for a better one?
 *
 * A "successful" Jina read of a JS-heavy page is often a near-empty shell: the
 * nav, a cookie banner, and nothing else. That reads as success to the caller
 * and is precisely how a real menu becomes "no menu listed on this site". A
 * page with almost no text AND almost no links found nothing worth having.
 *
 * Deliberately generous — this gate decides when to spend money, so it should
 * only fire on reads that are obviously useless, not merely thin.
 */
const THIN_MARKDOWN_CHARS = 600;
const THIN_LINK_COUNT = 5;

export function readerResultIsThin(result: ReaderResult): boolean {
  const hasSource = result.pdfLinks.length > 0 || result.imageUrls.length > 0;
  if (hasSource) return false; // found a menu source — good enough, don't pay again
  return result.markdown.length < THIN_MARKDOWN_CHARS && result.links.length < THIN_LINK_COUNT;
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function splitLinks(links: string[], base: string): { pdfLinks: string[]; imageUrls: string[] } {
  const pdfLinks: string[] = [];
  const imageUrls: string[] = [];
  for (const raw of links) {
    const abs = absolutize(raw, base);
    if (!abs) continue;
    const lower = abs.toLowerCase().split('?')[0];
    if (lower.endsWith('.pdf') || lower.includes('/pdf/') || lower.includes('menu.pdf')) {
      pdfLinks.push(abs);
    } else if (/\.(jpe?g|png|webp)$/.test(lower)) {
      imageUrls.push(abs);
    }
  }
  return { pdfLinks: dedupe(pdfLinks), imageUrls: dedupe(imageUrls) };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Why Firecrawl stopped answering, if it did. Same reasoning as `jinaStatus`:
 * a provider that swallows its own HTTP status turns a quota problem into
 * "this restaurant has no menu", which is the failure mode this whole change
 * exists to kill.
 */
let firecrawlDisabledReason: string | null = null;

export function firecrawlStatus(): string | null {
  return firecrawlDisabledReason;
}
export function resetFirecrawlCircuit(): void {
  firecrawlDisabledReason = null;
}

/** Credit/auth failures are permanent for this process; 429 is not. */
const FIRECRAWL_FATAL_STATUSES = new Set([401, 402, 403]);

async function readWithFirecrawl(url: string, timeoutMs = READER_TIMEOUT_MS): Promise<ReaderResult | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  if (firecrawlDisabledReason) return null;
  try {
    const call = () =>
      fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          formats: ['markdown', 'rawHtml', 'links', 'screenshot'],
          onlyMainContent: false,
          // Firecrawl enforces its OWN scrape timeout (30s by default) and
          // answers HTTP 408 when it expires — so raising only our client-side
          // budget changed nothing. Run #40: we waited 90s, Firecrawl gave up at
          // exactly 30s on a 27.7 MB PDF. Ask it for the same budget we're
          // prepared to wait, less a margin so its 408 arrives before our abort
          // (a real answer, even a refusal, beats a bare timeout).
          timeout: Math.max(timeoutMs - 5000, 10000),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res = await call();
    // Firecrawl's plans cap requests per minute, and a batch run (six sites,
    // several pages each) trips that easily. Observed 2026-08-05: three sites
    // scraped fine, then every later one failed in ~100ms — a rate limit, not
    // a scrape failure, silently reported as "no menu". One bounded retry.
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 8000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
      res = await call();
    }
    if (FIRECRAWL_FATAL_STATUSES.has(res.status)) {
      const body = await res.text().catch(() => '');
      firecrawlDisabledReason =
        `HTTP ${res.status} — ${res.status === 402 ? 'out of credits' : 'key rejected'}` +
        `${body ? ` (${body.slice(0, 160).replace(/\s+/g, ' ')})` : ''}`;
      console.error(`[reader] Firecrawl disabled for this process: ${firecrawlDisabledReason}`);
      return null;
    }
    if (!res.ok) {
      console.error(`[reader] Firecrawl HTTP ${res.status} for ${url}`);
      return null;
    }

    const json = (await res.json()) as {
      success?: boolean;
      data?: {
        markdown?: string;
        rawHtml?: string;
        links?: string[];
        screenshot?: string;
        metadata?: { title?: string; sourceURL?: string; statusCode?: number };
      };
    };
    const data = json.data;
    if (!data) return null;

    const finalUrl = data.metadata?.sourceURL || url;
    const links = (data.links ?? []).filter(Boolean);
    const { pdfLinks, imageUrls } = splitLinks(links, finalUrl);

    const markdown = (data.markdown ?? '').trim();
    if (!markdown && !data.rawHtml) return null;

    return {
      markdown,
      html: data.rawHtml ?? '',
      links: dedupe(links.map((l) => absolutize(l, finalUrl)).filter(Boolean) as string[]),
      imageUrls,
      pdfLinks,
      screenshotUrl: data.screenshot || undefined,
      finalUrl,
      title: data.metadata?.title ?? '',
      provider: 'firecrawl',
    };
  } catch {
    return null;
  }
}

/**
 * Jina failures that will repeat identically on every subsequent page, so
 * there is no point paying the round-trip again in this process:
 *   401 — key missing or invalid
 *   402 — account out of credit (a depleted/negative balance)
 *   403 — Cloudflare challenge, which is what a keyless request now gets
 * 429 is deliberately NOT here: rate limiting IS transient and already has a
 * backoff retry below.
 */
const JINA_FATAL_STATUSES = new Set([401, 402, 403]);
let jinaDisabledReason: string | null = null;

/** Test seam + diagnostics: why Jina was taken out of the rotation, if it was. */
export function jinaStatus(): string | null {
  return jinaDisabledReason;
}
export function resetJinaCircuit(): void {
  jinaDisabledReason = null;
}

/**
 * Jina Reader returns Markdown for a JS-rendered page. A JINA_API_KEY is now
 * REQUIRED: keyless requests get a Cloudflare challenge (verified twice —
 * 2026-08-05 run #29, and again 2026-08-06 run #41). It does not return
 * rawHtml; we ask for the links/images sections so we can still discover PDFs
 * and image menus.
 */
async function readWithJina(url: string, timeoutMs = READER_TIMEOUT_MS): Promise<ReaderResult | null> {
  // No key means no Jina, full stop. The keyless tier is gone, so attempting it
  // buys a guaranteed 403 — a wasted round-trip on the first page of every
  // process (on serverless, that's every cold start) before we reach the
  // provider that works. Returning early keeps the whole path intact: set
  // JINA_API_KEY and Jina is first in line again with no code change.
  if (!process.env.JINA_API_KEY) return null;
  // Circuit open: a bad or unfunded key fails the same way every time, and
  // retrying it per page just adds latency to every analysis before we get to
  // the provider that actually works.
  if (jinaDisabledReason) return null;
  try {
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      'X-Return-Format': 'markdown',
      // Ask Jina to append discovered links/images as a separate section.
      'X-With-Links-Summary': 'true',
      'X-With-Images-Summary': 'true',
      Accept: 'application/json',
    };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;

    let res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    // Keyless tier is ~20 rpm — long QA runs hit 429s. One bounded backoff
    // retry keeps batch runs alive without blowing the API route time budget.
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 12000));
      res = await fetch(`https://r.jina.ai/${url}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    }
    if (JINA_FATAL_STATUSES.has(res.status)) {
      // No keyless branch here any more: we return before the request when
      // there is no key, so a 403 that reaches this point is a real refusal of
      // a real key, not the Cloudflare challenge the keyless tier used to give.
      const meaning =
        res.status === 402
          ? 'account out of credit'
          : res.status === 401
            ? 'key invalid'
            : 'forbidden (key rejected)';
      jinaDisabledReason = `HTTP ${res.status} — ${meaning}`;
      console.error(`[reader] Jina disabled for this process: ${jinaDisabledReason}`);
      return null;
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: {
        title?: string;
        url?: string;
        content?: string;
        links?: Record<string, string> | string[];
        images?: Record<string, string> | string[];
      };
    };
    const data = json.data;
    if (!data?.content) return null;

    const finalUrl = data.url || url;
    const linkValues = data.links
      ? Array.isArray(data.links)
        ? data.links
        : Object.values(data.links)
      : [];
    const imageValues = data.images
      ? Array.isArray(data.images)
        ? data.images
        : Object.values(data.images)
      : [];

    const { pdfLinks, imageUrls: pdfImageUrls } = splitLinks(linkValues, finalUrl);
    const imageUrls = dedupe([
      ...pdfImageUrls,
      ...(imageValues
        .map((i) => absolutize(i, finalUrl))
        .filter(Boolean) as string[]),
    ]);

    return {
      markdown: data.content.trim(),
      html: '',
      links: dedupe(linkValues.map((l) => absolutize(l, finalUrl)).filter(Boolean) as string[]),
      imageUrls,
      pdfLinks,
      finalUrl,
      title: data.title ?? '',
      provider: 'jina',
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a full-page screenshot URL for last-resort vision extraction. Works on
 * Jina's keyless free tier (pageshot) and via Firecrawl when configured.
 * Returns a hosted image URL or null. Never throws.
 */
export async function fetchScreenshot(url: string): Promise<string | null> {
  const provider = selectProvider();
  if (provider === 'off') return null;

  // Firecrawl: dedicated screenshot scrape. Runs under 'auto' too (not just an
  // explicit READER_PROVIDER=firecrawl) — this is the last-resort vision
  // fallback, so it should use whatever reader is actually configured, the
  // same as every other read in this file.
  if (provider !== 'jina' && process.env.FIRECRAWL_API_KEY) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['screenshot@fullPage'] }),
        signal: AbortSignal.timeout(clampTimeout(30000)),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { screenshot?: string } };
        if (json.data?.screenshot) return json.data.screenshot;
      }
    } catch {
      // fall through to Jina
    }
  }

  // No key, or the circuit is open (a prior call this process already found
  // Jina unfunded/invalid) — skip the guaranteed-fail round-trip. Same guard
  // readWithJina uses; this call was missing it, so a resumed analysis could
  // burn up to 40s hitting a key already known dead this process.
  if (!process.env.JINA_API_KEY || jinaDisabledReason) return null;

  // Jina pageshot: returns a hosted full-page screenshot URL.
  try {
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      'X-Return-Format': 'pageshot',
      Accept: 'application/json',
    };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(clampTimeout(40000)),
      redirect: 'follow',
    });
    if (JINA_FATAL_STATUSES.has(res.status)) {
      jinaDisabledReason = `HTTP ${res.status} — screenshot call rejected`;
      console.error(`[reader] Jina disabled for this process: ${jinaDisabledReason}`);
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { pageshotUrl?: string; screenshotUrl?: string } };
    return json.data?.pageshotUrl || json.data?.screenshotUrl || null;
  } catch {
    return null;
  }
}

/**
 * Short-lived page cache — the single biggest source of wasted reader spend.
 *
 * One restaurant is read several times over: discovery fetches /menus to see
 * what is on it, then extraction fetches /menus again seconds later to read the
 * dishes off it. Deep discovery and branch crawling repeat pages the same way.
 * Across the six QA sites roughly a third of all reads were a page we had
 * already fetched moments earlier — paid for twice, and waited for twice.
 *
 * A short TTL rather than a per-request object: threading a context through
 * scraper → discovery → extract would touch every signature for the same
 * effect. 5 minutes comfortably covers one analysis (seconds to ~2 min) while
 * being far too short to serve anyone a stale menu; a re-search tomorrow, or an
 * admin reparse, reads the site fresh.
 */
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_CACHE_MAX = 200;
const pageCache = new Map<string, { at: number; result: ReaderResult | null; timeoutMs: number }>();

/** Test seam: number of live entries. */
export function pageCacheSize(): number {
  return pageCache.size;
}
export function clearPageCache(): void {
  pageCache.clear();
}

function cacheGet(url: string, timeoutMs: number): { result: ReaderResult | null } | undefined {
  const hit = pageCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PAGE_CACHE_TTL_MS) {
    pageCache.delete(url);
    return undefined;
  }
  // A cached *failure* is only evidence for the budget that produced it. The
  // document path deliberately asks for a longer one (a 26 MB PDF times out at
  // 25s and succeeds at 90s), so serving it the earlier null would cache the
  // very bug this fixes. A cached success is valid for any budget.
  if (!hit.result && hit.timeoutMs < timeoutMs) return undefined;
  return hit;
}

function cacheSet(url: string, result: ReaderResult | null, timeoutMs: number): void {
  // Oldest-first eviction: insertion order is Map's iteration order, and every
  // write is a fresh insert, so the first key is the oldest.
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(url, { at: Date.now(), result, timeoutMs });
}

export async function readPage(url: string, timeoutMs = READER_TIMEOUT_MS): Promise<ReaderResult | null> {
  // The reader hands `url` to Jina/Firecrawl, which fetch it on our behalf and
  // bill us for it. Guarding here keeps us from paying a third party to probe
  // internal addresses on an attacker's behalf.
  try {
    await assertPublicUrl(url);
  } catch {
    return null;
  }
  // Never outlive the request. DOCUMENT_TIMEOUT_MS is 90s, which is longer than
  // a Vercel function is allowed to exist — asking for it inside one killed the
  // whole analysis instead of just this read.
  timeoutMs = clampTimeout(timeoutMs);
  const cached = cacheGet(url, timeoutMs);
  if (cached) return cached.result;
  const result = await readPageUncached(url, timeoutMs);
  // Negative results are cached too: a page that just refused to render will
  // refuse again thirty seconds later, and retrying it per candidate is exactly
  // the duplicated work this exists to stop.
  cacheSet(url, result, timeoutMs);
  return result;
}

async function readPageUncached(url: string, timeoutMs: number): Promise<ReaderResult | null> {
  const provider = selectProvider();
  if (provider === 'off') return null;
  if (provider === 'jina') return readWithJina(url, timeoutMs);
  if (provider === 'firecrawl') {
    const result = await readWithFirecrawl(url, timeoutMs);
    // Explicitly-chosen Firecrawl still degrades to keyless Jina rather than
    // returning nothing — a missing key shouldn't take the reader offline.
    return result ?? readWithJina(url, timeoutMs);
  }

  // auto: free first, pay only when the free read is useless.
  const jina = await readWithJina(url, timeoutMs);
  if (jina && !readerResultIsThin(jina)) return jina;
  if (!isFirecrawlConfigured()) {
    if (!jina) reportReaderOutage(url);
    return jina;
  }
  const firecrawl = await readWithFirecrawl(url, timeoutMs);
  // Keep Jina's thin result if the paid attempt also failed — some content
  // beats none, and we've already paid for the attempt either way.
  const result = firecrawl ?? jina;
  if (!result) reportReaderOutage(url);
  return result;
}
