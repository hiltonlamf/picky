import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { readPage } from './reader';

export interface ScrapeResult {
  url: string;
  canonicalUrl: string;
  title: string;
  menuText: string;
  menuUrl: string | null;
  menuImages?: string[];
  menuPdfUrls?: string[];
  menuLinks?: string[]; // candidate menu sub-page links (for discovery)
  screenshotUrl?: string; // hosted full-page screenshot from the reader, if any
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
  const full = url.toLowerCase();
  const lower = full.split('?')[0];
  return (
    PDF_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    lower.includes('/pdf/') ||
    full.includes('.pdf') ||
    full.includes('issuu.com') ||
    full.includes('drive.google.com/file') ||
    full.includes('flipbook') ||
    full.includes('format=pdf')
  );
}

const MENU_IMAGE_KEYWORDS = ['menu', 'food', 'carte', 'speise', 'dish', 'notions'];
const SKIP_IMAGE_KEYWORDS = ['logo', 'icon', 'favicon', 'avatar', 'banner', 'social', 'twitter', 'facebook', 'instagram'];

export function findMenuImages($: cheerio.CheerioAPI, baseUrl: string): string[] {
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

export function findMenuLinks(
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

  // PDFs are frequently embedded via <embed>/<iframe>/<object> (PDF viewers,
  // flipbooks) rather than plain <a> links — scan those too.
  $('embed[src], iframe[src], object[data]').each((_, el) => {
    const ref = $(el).attr('src') ?? $(el).attr('data') ?? '';
    const resolved = resolveUrl(ref, baseUrl);
    if (resolved && isPdfUrl(resolved)) pdfCandidates.push({ url: resolved, score: 5 });
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

async function fetchWithRetry(
  url: string,
  retries = 2,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    ...extraHeaders,
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

// Cookies that pre-accept Google's consent screen so we get the real page,
// not the EU cookie-consent interstitial (which contains no restaurant data).
const GOOGLE_CONSENT_COOKIE = 'CONSENT=YES+cb; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlfMjAyNDA';

// Extract the place/business name from a Google Maps URL — tries multiple formats.
//   /maps/place/Uno+Mas/@53.33,-6.26,17z/...  →  "Uno Mas"
//   /maps/search/?api=1&query=Uno+Mas&...     →  "Uno Mas"
//   consent.google.com/...?continue=<enc url> →  decoded + re-parsed
function extractPlaceNameFromMapsUrl(mapsUrl: string): string | null {
  try {
    let target = mapsUrl;
    const u = new URL(mapsUrl);
    // Consent-screen wrapper — unwrap the real URL
    const cont = u.searchParams.get('continue');
    if (cont) target = decodeURIComponent(cont);

    // Format 1: /maps/place/Uno+Mas/@...
    const placeMatch = target.match(/\/maps\/place\/([^/@?#]+)/);
    if (placeMatch?.[1]) {
      const name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
      if (name.length > 1) return name;
    }

    // Format 2: ?q=Uno+Mas or ?query=Uno+Mas (search-style Maps URLs)
    const tu = new URL(target);
    for (const param of ['q', 'query', 'search']) {
      const val = tu.searchParams.get(param);
      if (val && val.length > 1) return decodeURIComponent(val.replace(/\+/g, ' ')).trim();
    }
  } catch {}
  return null;
}

// Extract restaurant name from the HTML of any Google page (works even on
// consent walls or JavaScript-redirect shells).
function extractPlaceNameFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const sources = [
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="title"]').attr('content'),
    $('title').text(),
    $('h1').first().text(),
  ];
  for (const raw of sources) {
    if (!raw) continue;
    // "Uno Mas - Google Maps" / "Uno Mas | Maps" → "Uno Mas"
    const clean = raw
      .replace(/\s*[-|–]\s*(Google Maps?|Maps|Google)\s*$/i, '')
      .replace(/\s*•.*$/, '')
      .trim();
    if (clean.length > 1 && clean.length < 80) return clean;
  }
  return null;
}

// Extract @lat,lng from a Google Maps URL if present.
function extractCoordsFromMapsUrl(mapsUrl: string): { lat: string; lon: string } | null {
  try {
    let target = mapsUrl;
    const u = new URL(mapsUrl);
    const cont = u.searchParams.get('continue');
    if (cont) target = decodeURIComponent(cont);
    const m = target.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!m) return null;
    return { lat: m[1], lon: m[2] };
  } catch {
    return null;
  }
}

// Reverse-geocode coordinates to a town/city using OpenStreetMap Nominatim.
async function reverseGeocodeCity(lat: string, lon: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    const data = await res.json();
    const a = data?.address ?? {};
    const city = a.city || a.town || a.village || a.suburb || a.county;
    return city || null;
  } catch {
    return null;
  }
}

// Look up a restaurant in OpenStreetMap via Nominatim — returns website URL if present.
// OSM extratags include `website` for many restaurants in Ireland/UK.
async function nominatimLookup(name: string, city: string | null): Promise<string | null> {
  try {
    const q = encodeURIComponent(city ? `${name} ${city}` : name);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=5&extratags=1`,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(7000) }
    );
    const results = await res.json();
    for (const r of results ?? []) {
      const site = r?.extratags?.website ?? r?.extratags?.['contact:website'];
      if (site && isRestaurantWebsite(site)) {
        console.log(`[osm] found website for "${name}": ${site}`);
        return site.startsWith('http') ? site : `https://${site}`;
      }
    }
  } catch (err) {
    console.log(`[osm] nominatim failed: ${err}`);
  }
  return null;
}

// Pull restaurant-website candidates out of a DuckDuckGo results page.
function parseDuckDuckGoResults(html: string, exclusions: string[]): string[] {
  const $ = cheerio.load(html);
  const candidates: string[] = [];
  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') ?? '';
    if (!href) return;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) href = decodeURIComponent(uddg[1]);
    else if (href.startsWith('//')) href = 'https:' + href;
    if (href.startsWith('http') && isRestaurantWebsite(href, exclusions)) candidates.push(href);
  });
  return candidates;
}

// Search DuckDuckGo (scraper-friendly) for the restaurant's own site.
// Uses short timeouts — called only as fallback after OSM lookup fails.
async function searchDuckDuckGo(query: string, exclusions: string[] = []): Promise<string | null> {
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      });
      const html = await res.text();
      const candidates = parseDuckDuckGoResults(html, exclusions);
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => scoreAsRestaurantHomepage(b) - scoreAsRestaurantHomepage(a));
      console.log(`[ddg] query="${query}" → ${candidates.slice(0, 3).join(', ')}`);
      return candidates[0];
    } catch (err) {
      console.log(`[ddg] ${endpoint} failed: ${err}`);
    }
  }
  return null;
}

// Ask Claude for the restaurant's official website URL.
// Claude's training data includes most restaurants — this is faster and more
// reliable than scraping third-party services from a datacenter IP.
async function resolveViaClaudeLLM(name: string, city: string | null): Promise<string | null> {
  try {
    const client = new Anthropic();
    const where = city ? ` in ${city}` : '';
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `What is the official website URL for the restaurant called "${name}"${where}? Reply with only the URL (starting with https://) or the word "unknown" if you are not confident. Never invent a URL.`,
      }],
    });
    const text = (msg.content[0].type === 'text' ? msg.content[0].text : '').trim().split(/\s/)[0];
    if (!text.startsWith('http')) return null;

    // Verify the URL actually resolves before using it
    const probe = await fetch(text, {
      method: 'HEAD',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    });
    if (probe.ok || (probe.status >= 200 && probe.status < 500)) {
      console.log(`[llm] resolved "${name}" → ${text}`);
      return text;
    }
    console.log(`[llm] probe failed (${probe.status}): ${text}`);
  } catch (err) {
    console.log(`[llm] failed: ${err}`);
  }
  return null;
}

async function resolveGoogleMapsUrl(url: string): Promise<string | null> {
  let finalUrl = '';
  let html = '';

  // Step A: follow the short-link redirect, then refetch the resolved Google
  // page WITH consent cookies (so we get real content, not the consent wall).
  try {
    const res = await fetchWithRetry(url, 2, { Cookie: GOOGLE_CONSENT_COOKIE });
    finalUrl = res.url;
    html = await res.text();
    console.log(`[maps] fetched ${url} → ${finalUrl} (${html.length} bytes)`);

    // If we landed on a consent/sorry page, refetch the wrapped target with cookies.
    if (/consent\.google|\/sorry\//.test(finalUrl)) {
      try {
        const u = new URL(finalUrl);
        const cont = u.searchParams.get('continue');
        if (cont) {
          const res2 = await fetchWithRetry(decodeURIComponent(cont), 1, { Cookie: GOOGLE_CONSENT_COOKIE });
          finalUrl = res2.url;
          html = await res2.text();
          console.log(`[maps] bypassed consent → ${finalUrl} (${html.length} bytes)`);
        }
      } catch {}
    }
  } catch (err) {
    console.log(`[maps] initial fetch failed: ${err}`);
  }

  // Step B: try to read the website directly from the page (best case).
  if (html) {
    const $ = cheerio.load(html);

    // B1: JSON-LD structured data
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
              if (typeof node?.url === 'string' && isRestaurantWebsite(node.url)) return node.url;
            }
          }
        }
      } catch {}
    }

    // B2: scan embedded JSON blobs for the website URL
    const extracted = extractRestaurantUrlFromHtml(html);
    if (extracted) {
      console.log(`[maps] resolved via HTML regex: ${extracted}`);
      return extracted;
    }

    // B3: scored anchor tags
    const anchorCandidates: Array<{ href: string; score: number }> = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const text = ($(el).text() ?? '').toLowerCase();
      if (!isRestaurantWebsite(href)) return;
      let score = scoreAsRestaurantHomepage(href);
      if (text.includes('website') || text.includes('homepage')) score += 20;
      anchorCandidates.push({ href, score });
    });
    anchorCandidates.sort((a, b) => b.score - a.score);
    if (anchorCandidates[0]) {
      console.log(`[maps] resolved via anchor: ${anchorCandidates[0].href}`);
      return anchorCandidates[0].href;
    }
  }

  // Step C: robust fallback — extract the business name from the URL path
  // (or HTML title if the URL lacks it) and look it up via OSM Nominatim first,
  // then DuckDuckGo. This sidesteps Google's bot defences entirely.
  const placeName =
    extractPlaceNameFromMapsUrl(finalUrl) ||
    extractPlaceNameFromMapsUrl(url) ||
    (html ? extractPlaceNameFromHtml(html) : null);

  if (placeName) {
    console.log(`[maps] extracted place name: "${placeName}"`);

    // Disambiguate with a town/city from the coordinates when available.
    let cityHint: string | null = null;
    const coords = extractCoordsFromMapsUrl(finalUrl) || extractCoordsFromMapsUrl(url);
    if (coords) cityHint = await reverseGeocodeCity(coords.lat, coords.lon);
    if (cityHint) console.log(`[maps] city hint: "${cityHint}"`);

    // C1: Ask Claude — it knows most restaurant websites from training data
    const llmResult = await resolveViaClaudeLLM(placeName, cityHint);
    if (llmResult) {
      console.log(`[maps] resolved via LLM: ${llmResult}`);
      return llmResult;
    }

    // C2: OpenStreetMap Nominatim structured lookup
    const osmResult = await nominatimLookup(placeName, cityHint);
    if (osmResult) {
      console.log(`[maps] resolved via OSM: ${osmResult}`);
      return osmResult;
    }

    // C3: DuckDuckGo web search fallback
    const queries = cityHint
      ? [`${placeName} restaurant ${cityHint}`, `${placeName} restaurant`]
      : [`${placeName} restaurant`];
    for (const q of queries) {
      const found = await searchDuckDuckGo(q);
      if (found) {
        console.log(`[maps] resolved via DDG: ${found}`);
        return found;
      }
    }
  }

  console.log(`[maps] all strategies exhausted for ${url}`);
  return null;
}

async function resolveSocialMediaUrl(url: string): Promise<string | null> {
  let socialHostname = '';
  let pageTitle = '';
  try {
    socialHostname = new URL(url).hostname.replace('www.', '');
    const res = await fetchWithRetry(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    pageTitle = $('meta[property="og:title"]').attr('content') ?? $('title').text() ?? '';

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
    if (externalLink) return externalLink;
  } catch {
    // fall through to web-search fallback
  }

  // Strategy 4: web-search fallback — social platforms heavily block server-side
  // fetches, so use the profile name/handle to find the restaurant's own site.
  // Prefer the human-readable og:title; fall back to the @handle in the URL.
  const handle = (() => {
    try {
      const seg = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
      return seg.replace(/^@/, '');
    } catch {
      return '';
    }
  })();
  // og:title is often "Name (@handle) • Instagram photos..." — keep the leading name.
  const cleanTitle = pageTitle.split(/[(|•·\-–]/)[0].trim();
  const searchTerm = cleanTitle.length > 2 ? cleanTitle : handle;

  if (searchTerm) {
    console.log(`[social] fallback term: "${searchTerm}"`);
    // Try Claude first — it knows most restaurant websites
    const llmResult = await resolveViaClaudeLLM(searchTerm, null);
    if (llmResult) return llmResult;
    // Fall back to DuckDuckGo
    const found = await searchDuckDuckGo(`${searchTerm} restaurant`, [socialHostname]);
    if (found) return found;
  }

  return null;
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

type HtmlPageResult = {
  text: string;
  menuUrl: string | null;
  finalUrl: string;
  title: string;
  menuImages: string[];
  menuPdfUrls: string[];
  menuLinks: string[];
  screenshotUrl?: string;
};

function dedupeStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function scrapeHtmlPage(url: string, depth = 0): Promise<HtmlPageResult> {
  const res = await fetchWithRetry(url);
  const finalUrl = res.url || url;
  const staticHtml = await res.text();

  // Top-level pages: also run a JS-rendering reader so dynamic sites
  // (Weebly/Wix/Squarespace) and lazy-loaded menus are captured. The reader is
  // best-effort and returns null when no provider/key is available or on error.
  const reader = depth === 0 ? await readPage(finalUrl).catch(() => null) : null;

  // Use the reader's rawHtml for DOM extraction when present (Firecrawl),
  // otherwise the static HTML still carries anchor tags for link discovery.
  const $ = cheerio.load(reader?.html && reader.html.length > staticHtml.length ? reader.html : staticHtml);

  // Find links and images BEFORE extractText
  const { htmlLinks: cheerioLinks, pdfLinks: cheerioPdfs } =
    depth === 0 ? findMenuLinks($, finalUrl) : { htmlLinks: [], pdfLinks: [] };
  const cheerioImages = findMenuImages($, finalUrl);

  // Merge reader-discovered sources with cheerio-discovered ones. Reader image
  // URLs bypass cheerio's logo/icon heuristic, so re-apply the skip filter here.
  const readerImages = (reader?.imageUrls ?? []).filter(
    (u) => !SKIP_IMAGE_KEYWORDS.some((k) => u.toLowerCase().includes(k)) && !/\.(gif|svg)(\?|$)/i.test(u)
  );
  const menuPdfUrls = dedupeStrings([...cheerioPdfs, ...(reader?.pdfLinks ?? [])]);
  const menuImages = dedupeStrings([...cheerioImages, ...readerImages]).slice(0, 6);
  // Augment scored cheerio sub-page links with reader links that mention a menu.
  const readerMenuLinks = (reader?.links ?? []).filter((l) =>
    MENU_LINK_KEYWORDS.some((k) => l.toLowerCase().includes(k))
  );
  const menuLinks = dedupeStrings([...cheerioLinks, ...readerMenuLinks]);

  // Prefer the reader's clean rendered text when it looks substantive.
  const cheerioText = extractText($);
  const readerText = reader?.markdown ?? '';
  const text = readerText.length > cheerioText.length && readerText.length > 200 ? readerText : cheerioText;

  // "Menu | Uno Mas" → take last part if first is a generic section name
  const GENERIC_PAGE_WORDS = new Set([
    'menu', 'home', 'food', 'about', 'contact', 'welcome',
    'index', 'start', 'page', 'sample menu', 'our menu',
  ]);
  const rawTitle = reader?.title || $('title').text().trim();
  const titleParts = rawTitle.split(/[|\-–]/).map((s) => s.trim()).filter(Boolean);
  let title =
    titleParts.length > 1 && GENERIC_PAGE_WORDS.has(titleParts[0].toLowerCase())
      ? titleParts[titleParts.length - 1]
      : (titleParts[0] ?? '');
  if (!title) title = $('h1').first().text().trim();

  if (looksLikeMenu(text) || depth > 0) {
    return {
      text,
      menuUrl: depth > 0 ? url : null,
      finalUrl,
      title,
      menuImages,
      menuPdfUrls,
      menuLinks,
      screenshotUrl: reader?.screenshotUrl,
    };
  }

  // Try menu sub-pages in order, return first that has meaningful content
  for (const link of menuLinks) {
    try {
      const menuRes = await scrapeHtmlPage(link, depth + 1);
      if (menuRes.text.length >= 200) {
        return {
          ...menuRes,
          menuUrl: link,
          title: menuRes.title || title,
          menuImages: menuRes.menuImages.length ? menuRes.menuImages : menuImages,
          menuPdfUrls: menuRes.menuPdfUrls.length ? menuRes.menuPdfUrls : menuPdfUrls,
          menuLinks,
          screenshotUrl: menuRes.screenshotUrl ?? reader?.screenshotUrl,
        };
      }
    } catch {
      // try next link
    }
  }

  return {
    text,
    menuUrl: null,
    finalUrl,
    title,
    menuImages,
    menuPdfUrls,
    menuLinks,
    screenshotUrl: reader?.screenshotUrl,
  };
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
        menuLinks: result.menuLinks,
        screenshotUrl: result.screenshotUrl,
        urlType: 'html',
      };
    }
    const platform = url.includes('instagram') ? 'Instagram'
      : url.includes('facebook') ? 'Facebook'
      : url.includes('tiktok') ? 'TikTok'
      : url.includes('twitter') || url.includes('x.com') ? 'Twitter/X'
      : 'that social page';
    return {
      url,
      canonicalUrl: url,
      title: 'Social media page',
      menuText: '',
      menuUrl: null,
      urlType,
      warning: `We opened the ${platform} page but couldn't find a link to the restaurant's website. Try pasting their website URL directly.`,
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
        menuLinks: result.menuLinks,
        screenshotUrl: result.screenshotUrl,
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
      warning: "We found the restaurant on Google Maps but couldn't track down their website. Try pasting the restaurant's website URL directly.",
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
            menuLinks: result.menuLinks,
            screenshotUrl: result.screenshotUrl,
            urlType: 'html',
          };
        }
      }
    } catch {
      // fall through to standard scrape of the review page
    }
  }

  // Standard HTML scraping
  const { text, menuUrl, finalUrl, title: pageTitle, menuImages, menuPdfUrls, menuLinks, screenshotUrl } =
    await scrapeHtmlPage(url);
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
        menuLinks,
        screenshotUrl,
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
        menuLinks,
        screenshotUrl,
        urlType: 'html',
      };
    }
    if (screenshotUrl) {
      // Reader rendered the page but text was thin — fall back to a screenshot
      // for vision extraction (e.g. fully image-based or canvas menus).
      return {
        url,
        canonicalUrl: finalUrl,
        title,
        menuText: '',
        menuUrl: null,
        menuLinks,
        screenshotUrl,
        urlType: 'html',
      };
    }
    throw new Error(
      "We opened the page but couldn't find any readable content — the site may be JavaScript-only or require a login. Try pasting a direct link to the menu page."
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
    menuLinks,
    screenshotUrl,
    urlType: 'html',
  };
}
