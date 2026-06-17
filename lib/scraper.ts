import * as cheerio from 'cheerio';

export interface ScrapeResult {
  url: string;
  canonicalUrl: string;
  title: string;
  menuText: string;
  menuUrl: string | null;
  menuImages?: string[];
  menuPdfUrls?: string[];
  urlType: 'html' | 'pdf' | 'google_maps' | 'social' | 'unknown';
  warning?: string;
}

const MENU_LINK_KEYWORDS = [
  'menu', 'food', 'eat', 'dishes', 'cuisine', 'carte',
  'speisekarte', 'kaart', 'menukaart',
];

const EXCLUDED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4'];
const PDF_EXTENSIONS = ['.pdf'];

function isPdfUrl(url: string): boolean {
  const lower = url.toLowerCase().split('?')[0];
  return PDF_EXTENSIONS.some((ext) => lower.endsWith(ext)) || lower.includes('/pdf/') || lower.includes('menu.pdf');
}

const MENU_IMAGE_KEYWORDS = ['menu', 'food', 'carte', 'speise', 'dish', 'notions'];
const SKIP_IMAGE_KEYWORDS = ['logo', 'icon', 'favicon', 'avatar', 'banner', 'social', 'twitter', 'facebook', 'instagram'];

function findMenuImages($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const candidates: Array<{ url: string; score: number }> = [];

  $('img[src], img[data-src]').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? '';
    const alt = ($(el).attr('alt') ?? '').toLowerCase();
    const resolved = resolveUrl(src, baseUrl);
    if (!resolved?.startsWith('http')) return;

    const srcLower = resolved.toLowerCase();
    if (SKIP_IMAGE_KEYWORDS.some((k) => srcLower.includes(k) || alt.includes(k))) return;
    if (srcLower.includes('.gif') || srcLower.includes('.svg')) return;

    let score = 1;
    for (const kw of MENU_IMAGE_KEYWORDS) {
      if (srcLower.includes(kw)) score += 10;
      if (alt.includes(kw)) score += 5;
    }
    const w = parseInt($(el).attr('width') ?? '0', 10);
    const h = parseInt($(el).attr('height') ?? '0', 10);
    if (w > 400 || h > 400) score += 2;

    candidates.push({ url: resolved, score });
  });

  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const key = c.url.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((c) => {
      // Request a reasonable resolution from Squarespace CDN
      if (c.url.includes('squarespace-cdn.com') || c.url.includes('squarespace.com')) {
        return c.url.split('?')[0] + '?format=1500w';
      }
      return c.url.split('?')[0];
    });
}

// Looks like a real browser — avoid bot detection
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Domains that are never a restaurant's own website
const NON_RESTAURANT_DOMAINS = [
  // Google
  'google.com', 'google.ie', 'google.co.uk', 'googleapis.com', 'goo.gl',
  'googletagmanager.com', 'googleusercontent.com', 'googlevideo.com',
  'doubleclick.net', 'ggpht.com', 'maps.app',
  // Social media
  'youtube.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com',
  'x.com', 'linkedin.com', 'tiktok.com', 'pinterest.com', 'snapchat.com',
  // Tech / infra
  'apple.com', 'microsoft.com', 'amazon.com', 'cloudflare.com',
  'schema.org', 'w3.org', 'openstreetmap.org', 'w3schools.com',
  // Review / discovery sites
  'yelp.com', 'tripadvisor.com', 'zomato.com', 'opentable.com', 'thefork.com',
  'happycow.net', 'foursquare.com', 'lovin.ie', 'timeout.com',
  // Delivery platforms — use base name to cover all country TLDs (.ie, .co.uk, .com, etc.)
  'deliveroo.', 'ubereats.com', 'just-eat.', 'doordash.com',
  'grubhub.com', 'seamless.com', 'menulog.', 'hungryhouse.',
  'wolt.com', 'bolt.eu', 'flipdish.',
  // Reservation / booking platforms
  'resdiary.com', 'resdiary.net', 'quandoo.com', 'bookatable.com',
  'sevenrooms.com', 'resy.com', 'booking.com', 'toasttab.com',
  'opentable.com', 'tock.com', 'eatwith.com', 'diningout.ie',
  // Ordering / menu platforms
  'order.bar', 'bopple.com', 'square.site', 'squareup.com',
  // Link-in-bio / aggregators (we want the real site, not the hub)
  'linktr.ee', 'linktree.com', 'beacons.ai', 'bio.site', 'campsite.bio',
];

const NON_RESTAURANT_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico',
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3',
];

function isRestaurantWebsite(candidate: string, additionalExclusions: string[] = []): boolean {
  try {
    const u = new URL(candidate);
    const lower = candidate.toLowerCase();
    if (!u.hostname.includes('.')) return false;
    if ([...NON_RESTAURANT_DOMAINS, ...additionalExclusions].some(ex => lower.includes(ex))) return false;
    const path = u.pathname.toLowerCase();
    if (NON_RESTAURANT_EXTENSIONS.some(ext => path.endsWith(ext))) return false;
    if (candidate.length > 300) return false;
    return true;
  } catch {
    return false;
  }
}

// Score a URL by how likely it is to be a restaurant's own homepage.
// Higher = better. Prefer root paths, no query strings, shorter total length.
function scoreAsRestaurantHomepage(url: string): number {
  try {
    const u = new URL(url);
    let score = 100;
    const pathDepth = u.pathname.split('/').filter(Boolean).length;
    score -= pathDepth * 20;          // deep paths → probably not the homepage
    if (u.search) score -= 40;        // query strings → tracking / booking links
    if (u.hash) score -= 10;
    score -= Math.floor(url.length / 15); // shorter URL → more likely a root domain
    return score;
  } catch {
    return -999;
  }
}

// Scan raw HTML for URLs embedded in JSON string contexts (standard + escaped variants).
// Collects all candidates, then returns the one most likely to be the restaurant homepage.
function extractRestaurantUrlFromHtml(html: string, additionalExclusions: string[] = []): string | null {
  // Cap at 2 MB for performance, then unescape \/ (Google Maps JSON encodes slashes this way)
  let cap = html.slice(0, 2 * 1024 * 1024);
  cap = cap.replace(/\\\//g, '/'); // "https:\/\/www.unomas.ie\/" → "https://www.unomas.ie/"

  // Priority pass: look for patterns specific to Google Maps website fields
  const mapsWebsitePatterns = [
    // Google Maps internal data fields
    /website_uri[^"]{0,30}"(https?:\/\/[^"\\]+)"/,
    /"website"\s*:\s*"(https?:\/\/[^"\\]+)"/,
    /"primaryUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/,
    // Array position patterns from Maps data (URL as first non-null in array)
    /\["(https?:\/\/[^"\\]+)",null,null,null/,
    /\["(https?:\/\/[^"\\]+)",null,null\]/,
    // "externalLinks" context
    /externalLinks[^[]{0,50}\["(https?:\/\/[^"\\]+)"/,
  ];
  for (const p of mapsWebsitePatterns) {
    const m = cap.match(p);
    if (m?.[1] && isRestaurantWebsite(m[1], additionalExclusions)) {
      console.log(`[maps] found via targeted pattern: ${m[1]}`);
      return m[1];
    }
  }

  // General pass: collect all candidate URLs then pick the best-scoring one
  const patterns = [
    /"(https?:\/\/[^"\\]{5,300})"/g,
    /\\x22(https?:\/\/[^\\]{5,300})\\x22/g,
    /\\u0022(https?:\/\/[^\\]{5,300})\\u0022/g,
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(cap)) !== null) {
      const u = match[1];
      if (!seen.has(u) && isRestaurantWebsite(u, additionalExclusions)) {
        seen.add(u);
        candidates.push(u);
        if (candidates.length >= 60) break; // enough to find the homepage
      }
    }
    if (candidates.length >= 60) break;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => scoreAsRestaurantHomepage(b) - scoreAsRestaurantHomepage(a));
  console.log(`[maps] top candidates: ${candidates.slice(0, 5).join(', ')}`);
  return candidates[0];
}

function detectUrlType(url: string): ScrapeResult['urlType'] {
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf') || lower.includes('/pdf/') || lower.includes('menu.pdf')) return 'pdf';
  if (lower.includes('maps.google') || lower.includes('maps.app.goo') || lower.includes('goo.gl/maps')) return 'google_maps';
  if (lower.includes('instagram.com') || lower.includes('facebook.com') || lower.includes('twitter.com') || lower.includes('tiktok.com')) return 'social';
  return 'html';
}

function isReviewSite(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('yelp.com') ||
    lower.includes('tripadvisor.com') ||
    lower.includes('zomato.com') ||
    lower.includes('opentable.com') ||
    lower.includes('thefork.com')
  );
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return '';
  }
}

// Does NOT mutate the cheerio DOM — only reads text
function extractText($: cheerio.CheerioAPI): string {
  const $clone = cheerio.load($.html());
  $clone('script, style, nav, footer, header, noscript, iframe, [aria-hidden="true"]').remove();
  return $clone('body').text().replace(/\s+/g, ' ').trim().slice(0, 40000);
}

function findMenuLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string
): { htmlLinks: string[]; pdfLinks: string[] } {
  const htmlCandidates: Array<{ url: string; score: number }> = [];
  const pdfCandidates: Array<{ url: string; score: number }> = [];
  let baseOrigin: string;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    return { htmlLinks: [], pdfLinks: [] };
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = ($(el).text() + ' ' + ($(el).attr('title') ?? '')).toLowerCase();
    const resolvedHref = resolveUrl(href, baseUrl);

    if (!resolvedHref) return;
    // Allow PDFs from any domain (CDNs, S3, etc.), but restrict HTML links to same origin
    const isExternal = !resolvedHref.startsWith(baseOrigin);
    if (EXCLUDED_EXTENSIONS.some((ext) => resolvedHref.toLowerCase().endsWith(ext))) return;
    if (resolvedHref === baseUrl) return;

    if (isPdfUrl(resolvedHref)) {
      let score = 0;
      for (const keyword of MENU_LINK_KEYWORDS) {
        if (text.includes(keyword)) score += 2;
        if (resolvedHref.toLowerCase().includes(keyword)) score += 3;
      }
      // Any PDF linked from a menu keyword anchor is a good candidate
      if (score > 0 || text.includes('download') || text.includes('pdf')) {
        pdfCandidates.push({ url: resolvedHref, score: score || 1 });
      }
      return;
    }

    if (isExternal) return;

    let score = 0;
    for (const keyword of MENU_LINK_KEYWORDS) {
      if (text.includes(keyword)) score += 2;
      if (resolvedHref.toLowerCase().includes(keyword)) score += 3;
    }
    if (score > 0) htmlCandidates.push({ url: resolvedHref, score });
  });

  const dedup = (candidates: Array<{ url: string; score: number }>, limit: number) => {
    candidates.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return candidates
      .filter((c) => {
        if (seen.has(c.url)) return false;
        seen.add(c.url);
        return true;
      })
      .slice(0, limit)
      .map((c) => c.url);
  };

  return { htmlLinks: dedup(htmlCandidates, 3), pdfLinks: dedup(pdfCandidates, 2) };
}

// Extract a restaurant's own website from a review site page (Yelp, TripAdvisor, etc.)
function findExternalWebsite($: cheerio.CheerioAPI, reviewSiteOrigin: string): string | null {
  const candidates: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const resolved = resolveUrl(href, reviewSiteOrigin);
    if (
      resolved.startsWith('http') &&
      !resolved.includes(new URL(reviewSiteOrigin).hostname) &&
      !resolved.includes('google.com') &&
      !resolved.includes('facebook.com') &&
      !resolved.includes('instagram.com') &&
      !resolved.includes('twitter.com') &&
      !resolved.includes('yelp.com') &&
      !resolved.includes('tripadvisor.com')
    ) {
      candidates.push(resolved);
    }
  });

  return candidates[0] ?? null;
}

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-IE,en;q=0.9,fr;q=0.8,de;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('Failed to fetch');
}

async function resolveGoogleMapsUrl(url: string): Promise<string | null> {
  try {
    const res = await fetchWithRetry(url);
    let finalUrl = res.url;
    let html = await res.text();
    console.log(`[maps] fetched ${url} → ${finalUrl} (${html.length} bytes)`);

    // Follow client-side redirects (meta-refresh or window.location JS redirect)
    const clientRedirectUrl = (() => {
      // meta http-equiv="refresh"
      const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^;]*;\s*url=([^"'\s>]+)/i)
        ?? html.match(/content=["'][^;]*;\s*url=([^"'\s>]+)[^>]*http-equiv=["']?refresh["']?/i);
      if (m?.[1]) return m[1].replace(/^['"]|['"]$/g, '');
      // JavaScript window.location redirect
      const js = html.match(/window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i)
        ?? html.match(/location\.replace\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i);
      if (js?.[1]) return js[1];
      return null;
    })();

    if (clientRedirectUrl?.startsWith('http')) {
      if (!clientRedirectUrl.includes('google.com') && isRestaurantWebsite(clientRedirectUrl)) {
        console.log(`[maps] client-redirect to non-google restaurant URL: ${clientRedirectUrl}`);
        return clientRedirectUrl;
      }
      if (clientRedirectUrl.startsWith('http')) {
        try {
          const res2 = await fetchWithRetry(clientRedirectUrl);
          finalUrl = res2.url;
          html = await res2.text();
          console.log(`[maps] followed client-redirect → ${finalUrl} (${html.length} bytes)`);
        } catch {}
      }
    }

    const $ = cheerio.load(html);

    // Strategy 1: JSON-LD structured data (most reliable — designed for machine reading)
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const data = JSON.parse($(el).html() ?? '');
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (typeof item?.url === 'string' && isRestaurantWebsite(item.url)) {
            console.log(`[maps] resolved via JSON-LD: ${item.url}`);
            return item.url;
          }
          if (Array.isArray(item?.['@graph'])) {
            for (const node of item['@graph']) {
              if (typeof node?.url === 'string' && isRestaurantWebsite(node.url)) {
                console.log(`[maps] resolved via JSON-LD @graph: ${node.url}`);
                return node.url;
              }
            }
          }
        }
      } catch {}
    }

    // Strategy 2: Google Maps embeds place data (including website) as JSON in the page —
    // scan the raw HTML for URLs in quoted/escaped string contexts
    const extracted = extractRestaurantUrlFromHtml(html);
    if (extracted) {
      console.log(`[maps] resolved via HTML regex: ${extracted}`);
      return extracted;
    }

    // Strategy 3: Fallback — anchor tag link extraction, scored
    const anchorCandidates: Array<{ href: string; score: number }> = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const text = ($(el).text() ?? '').toLowerCase();
      if (!isRestaurantWebsite(href)) return;
      let score = scoreAsRestaurantHomepage(href);
      // Boost if anchor text looks like a website label
      if (text.includes('website') || text.includes('web') || text.includes('homepage')) score += 20;
      anchorCandidates.push({ href, score });
    });
    anchorCandidates.sort((a, b) => b.score - a.score);
    const websiteLink = anchorCandidates[0]?.href ?? null;

    console.log(`[maps] anchor candidates: ${anchorCandidates.slice(0, 3).map(c => c.href).join(', ') || 'none'}`);

    // Log a snippet of the HTML for debugging when nothing was found
    if (!websiteLink) {
      console.log(`[maps] html snippet: ${html.slice(0, 500)}`);
    }

    return websiteLink ?? null;
  } catch (err) {
    console.log(`[maps] resolveGoogleMapsUrl failed: ${err}`);
    return null;
  }
}

async function resolveSocialMediaUrl(url: string): Promise<string | null> {
  try {
    const socialHostname = new URL(url).hostname.replace('www.', '');
    const res = await fetchWithRetry(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Strategy 1: JSON-LD structured data
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const data = JSON.parse($(el).html() ?? '');
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (typeof item?.url === 'string' && isRestaurantWebsite(item.url, [socialHostname])) return item.url;
          if (Array.isArray(item?.['@graph'])) {
            for (const node of item['@graph']) {
              if (typeof node?.url === 'string' && isRestaurantWebsite(node.url, [socialHostname])) return node.url;
            }
          }
        }
      } catch {}
    }

    // Strategy 2: Social platforms (Instagram, TikTok, Facebook) embed profile data as JSON —
    // includes an external_url / website field we can find via regex
    const extracted = extractRestaurantUrlFromHtml(html, [socialHostname]);
    if (extracted) return extracted;

    // Strategy 3: Anchor tags — platforms sometimes render the bio link statically
    const externalLink = $('a[href]').filter((_, el) => {
      const href = $(el).attr('href') ?? '';
      return isRestaurantWebsite(href, [socialHostname]);
    }).first().attr('href');

    return externalLink ?? null;
  } catch {
    return null;
  }
}

function looksLikeMenu(text: string): boolean {
  const lower = text.toLowerCase();
  const priceMatches =
    (text.match(/€\s*\d+/g) ?? []).length +
    (text.match(/£\s*\d+/g) ?? []).length;

  return (
    lower.includes('starter') ||
    lower.includes('starters') ||
    lower.includes('main course') ||
    lower.includes('mains') ||
    lower.includes('dessert') ||
    lower.includes('entrée') ||
    lower.includes('appetizer') ||
    lower.includes('para picar') ||
    lower.includes('à la carte') ||
    lower.includes('a la carte') ||
    priceMatches > 3
  );
}

async function scrapeHtmlPage(
  url: string,
  depth = 0
): Promise<{ text: string; menuUrl: string | null; finalUrl: string; title: string; menuImages: string[]; menuPdfUrls: string[] }> {
  const res = await fetchWithRetry(url);
  const finalUrl = res.url || url;
  const html = await res.text();
  const $ = cheerio.load(html);

  // Find links and images BEFORE extractText
  const { htmlLinks: menuLinks, pdfLinks } = depth === 0 ? findMenuLinks($, finalUrl) : { htmlLinks: [], pdfLinks: [] };
  const menuImages = findMenuImages($, finalUrl);

  const text = extractText($);

  // "Menu | Uno Mas" → take last part if first is a generic section name
  const GENERIC_PAGE_WORDS = new Set([
    'menu', 'home', 'food', 'about', 'contact', 'welcome',
    'index', 'start', 'page', 'sample menu', 'our menu',
  ]);
  const rawTitle = $('title').text().trim();
  const titleParts = rawTitle.split(/[|\-–]/).map((s) => s.trim()).filter(Boolean);
  let title =
    titleParts.length > 1 && GENERIC_PAGE_WORDS.has(titleParts[0].toLowerCase())
      ? titleParts[titleParts.length - 1]
      : (titleParts[0] ?? '');
  if (!title) title = $('h1').first().text().trim();

  if (looksLikeMenu(text) || depth > 0) {
    return { text, menuUrl: depth > 0 ? url : null, finalUrl, title, menuImages, menuPdfUrls: pdfLinks };
  }

  // Try menu sub-pages in order, return first that has meaningful content
  for (const link of menuLinks) {
    try {
      const menuRes = await scrapeHtmlPage(link, depth + 1);
      if (menuRes.text.length >= 200) {
        return { ...menuRes, menuUrl: link, title: menuRes.title || title, menuPdfUrls: menuRes.menuPdfUrls.length ? menuRes.menuPdfUrls : pdfLinks };
      }
    } catch {
      // try next link
    }
  }

  return { text, menuUrl: null, finalUrl, title, menuImages, menuPdfUrls: pdfLinks };
}

export async function scrapeRestaurant(rawUrl: string): Promise<ScrapeResult> {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = 'https://' + url;

  const urlType = detectUrlType(url);

  if (urlType === 'social') {
    const websiteUrl = await resolveSocialMediaUrl(url);
    if (websiteUrl) {
      const result = await scrapeHtmlPage(websiteUrl);
      return {
        url,
        canonicalUrl: websiteUrl,
        title: result.title || 'Restaurant',
        menuText: result.text,
        menuUrl: result.menuUrl,
        menuImages: result.menuImages,
        menuPdfUrls: result.menuPdfUrls,
        urlType: 'html',
      };
    }
    return {
      url,
      canonicalUrl: url,
      title: 'Social media page',
      menuText: '',
      menuUrl: null,
      urlType,
      warning:
        "Oops, it didn't work. We couldn't find the menu. Please directly paste the restaurant link.",
    };
  }

  if (urlType === 'google_maps') {
    const websiteUrl = await resolveGoogleMapsUrl(url);
    if (websiteUrl) {
      const result = await scrapeHtmlPage(websiteUrl);
      return {
        url,
        canonicalUrl: websiteUrl,
        title: result.title || 'Restaurant',
        menuText: result.text,
        menuUrl: result.menuUrl,
        menuImages: result.menuImages,
        menuPdfUrls: result.menuPdfUrls,
        urlType: 'html',
      };
    }
    return {
      url,
      canonicalUrl: url,
      title: 'Google Maps listing',
      menuText: '',
      menuUrl: null,
      urlType,
      warning:
        "Oops, it didn't work. We couldn't find the menu. Please directly paste the restaurant link.",
    };
  }

  if (urlType === 'pdf') {
    return {
      url,
      canonicalUrl: url,
      title: 'Menu PDF',
      menuText: '',
      menuUrl: url,
      menuPdfUrls: [url],
      urlType: 'pdf',
    };
  }

  // Review sites (Yelp, TripAdvisor, etc.) — try to find and use the restaurant's own website
  if (isReviewSite(url)) {
    try {
      const res = await fetchWithRetry(url);
      const html = await res.text();
      const $ = cheerio.load(html);
      const websiteUrl = findExternalWebsite($, url);
      if (websiteUrl) {
        const result = await scrapeHtmlPage(websiteUrl);
        if (result.text.length >= 200) {
          return {
            url,
            canonicalUrl: websiteUrl,
            title: result.title || 'Restaurant',
            menuText: result.text,
            menuUrl: result.menuUrl,
            menuImages: result.menuImages,
            menuPdfUrls: result.menuPdfUrls,
            urlType: 'html',
          };
        }
      }
    } catch {
      // fall through to standard scrape of the review page
    }
  }

  // Standard HTML scraping
  const { text, menuUrl, finalUrl, title: pageTitle, menuImages, menuPdfUrls } = await scrapeHtmlPage(url);
  const title = pageTitle || 'Restaurant';

  if (!text || text.length < 100) {
    if (menuPdfUrls && menuPdfUrls.length > 0) {
      // Menu is a linked PDF — return for PDF classification
      return {
        url,
        canonicalUrl: finalUrl,
        title,
        menuText: '',
        menuUrl: menuPdfUrls[0],
        menuPdfUrls,
        urlType: 'pdf',
      };
    }
    if (menuImages && menuImages.length > 0) {
      // Menu is likely in an image — return images for vision fallback
      return {
        url,
        canonicalUrl: finalUrl,
        title,
        menuText: '',
        menuUrl: null,
        menuImages,
        urlType: 'html',
      };
    }
    throw new Error(
      "Oops, it didn't work. We couldn't find the menu. Please directly paste the restaurant link."
    );
  }

  return {
    url,
    canonicalUrl: finalUrl,
    title,
    menuText: text,
    menuUrl,
    menuImages,
    menuPdfUrls,
    urlType: 'html',
  };
}
