/**
 * Provider-abstracted page reader.
 *
 * Acquires a URL's content with JavaScript rendering via an external reader API
 * so that JS-heavy sites (Weebly/Wix/Squarespace) and lazy-loaded menus are
 * captured. Always degrades gracefully: on a missing key or any error it returns
 * `null` so callers fall back to the existing cheerio path. Never throws.
 *
 * Provider selection:
 *   - READER_PROVIDER=firecrawl  → Firecrawl (needs FIRECRAWL_API_KEY)
 *   - READER_PROVIDER=jina       → Jina Reader (works keyless on the free tier)
 *   - READER_PROVIDER=off        → disabled (cheerio only)
 *   - unset → Firecrawl if FIRECRAWL_API_KEY is present, otherwise keyless Jina.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

type Provider = 'firecrawl' | 'jina' | 'off';

function selectProvider(): Provider {
  const explicit = (process.env.READER_PROVIDER ?? '').toLowerCase().trim();
  if (explicit === 'off') return 'off';
  if (explicit === 'firecrawl') return 'firecrawl';
  if (explicit === 'jina') return 'jina';
  // Auto: prefer Firecrawl when a key exists, else keyless Jina free tier.
  if (process.env.FIRECRAWL_API_KEY) return 'firecrawl';
  return 'jina';
}

/** Whether a JS-rendering reader is available (i.e. not disabled). */
export function isReaderEnabled(): boolean {
  return selectProvider() !== 'off';
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

async function readWithFirecrawl(url: string): Promise<ReaderResult | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'rawHtml', 'links', 'screenshot'],
        onlyMainContent: false,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;

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
 * Jina Reader returns Markdown for a JS-rendered page. The keyless free tier
 * works for low volume; an optional JINA_API_KEY raises the rate limit.
 * It does not return rawHtml; we ask for the links/images sections so we can
 * still discover PDFs and image menus.
 */
async function readWithJina(url: string): Promise<ReaderResult | null> {
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
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    // Keyless tier is ~20 rpm — long QA runs hit 429s. One bounded backoff
    // retry keeps batch runs alive without blowing the API route time budget.
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 12000));
      res = await fetch(`https://r.jina.ai/${url}`, {
        headers,
        signal: AbortSignal.timeout(25000),
        redirect: 'follow',
      });
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

  // Firecrawl: dedicated screenshot scrape.
  if (provider === 'firecrawl' && process.env.FIRECRAWL_API_KEY) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['screenshot@fullPage'] }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { screenshot?: string } };
        if (json.data?.screenshot) return json.data.screenshot;
      }
    } catch {
      // fall through to Jina
    }
  }

  // Jina pageshot (keyless): returns a hosted full-page screenshot URL.
  try {
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      'X-Return-Format': 'pageshot',
      Accept: 'application/json',
    };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(40000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { pageshotUrl?: string; screenshotUrl?: string } };
    return json.data?.pageshotUrl || json.data?.screenshotUrl || null;
  } catch {
    return null;
  }
}

export async function readPage(url: string): Promise<ReaderResult | null> {
  const provider = selectProvider();
  if (provider === 'off') return null;
  if (provider === 'firecrawl') {
    const result = await readWithFirecrawl(url);
    if (result) return result;
    // Fall back to keyless Jina if Firecrawl fails but is configured.
    return readWithJina(url);
  }
  return readWithJina(url);
}
