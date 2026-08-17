import * as cheerio from 'cheerio';

/**
 * Location extraction deliberately contains no model or page-reader calls.
 * Restaurant sites usually expose their own address as JSON-LD or in a normal
 * address block; treating that structured, first-party information as data is
 * both cheaper and safer than asking a model to infer it from surrounding copy.
 */
export type LocationConfidence = 'high' | 'medium' | 'low';
export type LocationSource = 'website_jsonld' | 'website_address_element' | 'website_map_link' | 'website_contact_page';

export interface LocationCandidate {
  address: string;
  latitude?: number;
  longitude?: number;
  confidence: LocationConfidence;
  source: LocationSource;
  sourceUrl: string;
}

type Json = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? compact : null;
}

function number(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function validCoordinates(latitude: number | undefined, longitude: number | undefined): latitude is number {
  return latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (!value || typeof value !== 'object') return null;
  const a = value as Json;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
    .map(text)
    .filter((v): v is string => !!v);
  return parts.length ? parts.join(', ') : null;
}

function hasRestaurantType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) =>
    typeof type === 'string' && /restaurant|foodestablishment|localbusiness|cafeorcoffeeshop|barorpub/i.test(type)
  );
}

function candidatesFromJson(value: unknown, sourceUrl: string): LocationCandidate[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => candidatesFromJson(item, sourceUrl));
  const item = value as Json;
  const nested = Array.isArray(item['@graph']) ? item['@graph'].flatMap((entry) => candidatesFromJson(entry, sourceUrl)) : [];
  if (!hasRestaurantType(item['@type'])) return nested;

  const address = normalizeAddress(item.address);
  if (!address) return nested;
  const geo = item.geo && typeof item.geo === 'object' ? (item.geo as Json) : {};
  const latitude = number(geo.latitude);
  const longitude = number(geo.longitude);
  return [
    {
      address,
      ...(validCoordinates(latitude, longitude) ? { latitude, longitude } : {}),
      confidence: 'high',
      source: 'website_jsonld',
      sourceUrl,
    },
    ...nested,
  ];
}

function coordinatesFromMapUrl(raw: string): { latitude?: number; longitude?: number; address?: string } {
  try {
    const url = new URL(raw);
    const at = raw.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (at) {
      const latitude = Number(at[1]);
      const longitude = Number(at[2]);
      return validCoordinates(latitude, longitude) ? { latitude, longitude } : {};
    }
    const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.searchParams.get('destination');
    if (!query) return {};
    const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      const latitude = Number(coords[1]);
      const longitude = Number(coords[2]);
      return validCoordinates(latitude, longitude) ? { latitude, longitude } : {};
    }
    return { address: text(query) ?? undefined };
  } catch {
    return {};
  }
}

function mapCandidatesFromDocument($: cheerio.CheerioAPI, sourceUrl: string): LocationCandidate[] {
  const candidates: LocationCandidate[] = [];
  $('iframe[src], a[href]').each((_, element) => {
    const raw = $(element).attr('src') ?? $(element).attr('href') ?? '';
    if (!/google\.[^/]+\/maps|maps\.app\.goo\.gl|openstreetmap\.org|\/maps\b/i.test(raw)) return;
    const parsed = coordinatesFromMapUrl(raw);
    if (!parsed.address && (parsed.latitude === undefined || parsed.longitude === undefined)) return;
    candidates.push({
      address: parsed.address ?? '',
      ...(parsed.latitude !== undefined && parsed.longitude !== undefined ? { latitude: parsed.latitude, longitude: parsed.longitude } : {}),
      confidence: parsed.address ? 'medium' : 'low',
      source: 'website_map_link',
      sourceUrl,
    });
  });
  return candidates;
}

// An Eircode or Dutch postcode is a strong enough signal to accept a compact
// visible text block as a published address. Many small restaurant sites put
// this in an ordinary <p>, not an <address> element or JSON-LD.
const VISIBLE_POSTCODE_RE = /\b(?:D(?:0[1-9]|1\d|2[0-4])|D6W)\s*[A-Z0-9]{4}\b|\b\d{4}\s?[A-Z]{2}\b/i;

function addressFromVisibleText($: cheerio.CheerioAPI, sourceUrl: string): LocationCandidate | null {
  for (const element of $('address, p, li').toArray()) {
    const copy = $(element).clone();
    copy.find('script, style, svg').remove();
    // Cheerio's text() concatenates <br>-separated text without a space.
    // Preserve the visible line breaks before compacting the address.
    copy.find('br').replaceWith(' ');
    const value = copy
      .text()
      .replace(/\s+/g, ' ')
      // Contact blocks often put phone/email after the address in the same
      // paragraph. Keep the street address but never display those details.
      .replace(/\b(?:phone|tel(?:ephone)?|email)\s*:?[\s\S]*$/i, '')
      // A compact footer may list telephone and email before the street line.
      // Remove only recognisable contact tokens; never infer the address.
      .replace(/^(?:\+?\d[\d\s().-]{5,})\s*/, '')
      .replace(/^[\w.+-]+@[\w.-]+\.[A-Z]{2,}\s*/i, '')
      .trim();
    const postcode = value.match(VISIBLE_POSTCODE_RE);
    if (value.length < 8 || value.length > 260 || !postcode || postcode.index === undefined) continue;
    return {
      // A footer can place the email/telephone immediately after an Eircode
      // without a \"Phone\" label. The postcode is the trusted end of the
      // address, so do not display whatever follows it.
      address: value.slice(0, postcode.index + postcode[0].length).trim(),
      confidence: 'medium',
      source: 'website_address_element',
      sourceUrl,
    };
  }
  return null;
}

/** Extract only evidence a restaurant deliberately publishes on its own page. */
export function extractLocationFromHtml(html: string, sourceUrl: string): LocationCandidate | null {
  const $ = cheerio.load(html);
  const structured: LocationCandidate[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      structured.push(...candidatesFromJson(JSON.parse($(element).contents().text()), sourceUrl));
    } catch {
      // Bad JSON-LD is common and must not break menu scraping.
    }
  });
  const mapCandidates = mapCandidatesFromDocument($, sourceUrl);
  const mapCoordinates = mapCandidates.find((candidate) => candidate.latitude !== undefined && candidate.longitude !== undefined);
  const withCoordinates = structured.find((candidate) => candidate.latitude !== undefined && candidate.longitude !== undefined);
  if (withCoordinates) return withCoordinates;
  if (structured[0]) {
    // The address remains explicitly published JSON-LD; the coordinate is from
    // the same restaurant page's explicit map link. No inference is involved.
    return mapCoordinates
      ? { ...structured[0], latitude: mapCoordinates.latitude, longitude: mapCoordinates.longitude }
      : structured[0];
  }

  const addressElement = $('address').first().text().replace(/\s+/g, ' ').trim();
  if (addressElement.length >= 8 && addressElement.length <= 300) {
    return {
      address: addressElement,
      ...(mapCoordinates ? { latitude: mapCoordinates.latitude, longitude: mapCoordinates.longitude } : {}),
      confidence: 'high', source: 'website_address_element', sourceUrl,
    };
  }
  const visibleAddress = addressFromVisibleText($, sourceUrl);
  if (visibleAddress) return visibleAddress;
  // Coordinates without a published street address are useful for automatic
  // neighbourhood assignment, but never shown as an invented address.
  return mapCandidates.find((candidate) => candidate.address) ?? mapCandidates[0] ?? null;
}

export function isCandidateInCity(candidate: LocationCandidate, city: string): boolean {
  const normalizedCity = city.trim().toLowerCase();
  // Coordinates are checked against city boundary data later. An address must
  // name the city explicitly before it can be auto-published.
  return candidate.address === '' || candidate.address.toLowerCase().includes(normalizedCity);
}

export type GeoPosition = { latitude: number; longitude: number };
export type GeoPolygon = GeoPosition[][];
export type GeoJsonGeometry = {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
};

/** Ray-casting point-in-polygon; boundary imports are GeoJSON [lng, lat]. */
export function pointInPolygon(point: GeoPosition, polygon: GeoPolygon): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      const intersects =
        a.latitude > point.latitude !== b.latitude > point.latitude &&
        point.longitude < ((b.longitude - a.longitude) * (point.latitude - a.latitude)) / (b.latitude - a.latitude) + a.longitude;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}

function geoJsonRingToPositions(ring: number[][]): GeoPosition[] {
  return ring
    .filter((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map(([longitude, latitude]) => ({ latitude, longitude }));
}

/** True when a coordinate falls within a Polygon or MultiPolygon GeoJSON shape. */
export function pointInGeoJson(point: GeoPosition, geometry: unknown): boolean {
  if (!geometry || typeof geometry !== 'object') return false;
  const value = geometry as GeoJsonGeometry;
  if (value.type === 'Polygon' && Array.isArray(value.coordinates)) {
    return pointInPolygon(point, (value.coordinates as number[][][]).map(geoJsonRingToPositions));
  }
  if (value.type === 'MultiPolygon' && Array.isArray(value.coordinates)) {
    return (value.coordinates as number[][][][]).some((polygon) =>
      pointInPolygon(point, polygon.map(geoJsonRingToPositions))
    );
  }
  return false;
}

function contactPageUrl(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  const page = new URL(pageUrl);
  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href') ?? '';
    const label = `${$(element).text()} ${href}`.toLowerCase();
    if (!/(contact|about|find[-_ ]?us|location|visit[-_ ]?us)/.test(label)) continue;
    try {
      const target = new URL(href, pageUrl);
      // Never use a directory/social profile as alleged first-party evidence.
      if (target.hostname === page.hostname && target.protocol.startsWith('http')) return target.href;
    } catch {
      // Continue scanning a malformed link.
    }
  }
  return null;
}

async function fetchStaticHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // An ordinary browser-like request, deliberately not Jina or Firecrawl.
        'User-Agent': 'Picky location verifier (+https://picky-app.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    return response.ok && /html|xhtml/i.test(contentType) ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The regular scraper has already fetched the homepage. Reuse that HTML and
 * make only the one conditional, same-domain Contact-page request needed to
 * find a published address. This deliberately avoids another reader or model
 * request on the normal parse path.
 */
export async function findLocationOnContactPage(homepageHtml: string, pageUrl: string): Promise<LocationCandidate | null> {
  const contactUrl = contactPageUrl(homepageHtml, pageUrl);
  if (!contactUrl) return null;
  const contactHtml = await fetchStaticHtml(contactUrl);
  const candidate = contactHtml ? extractLocationFromHtml(contactHtml, contactUrl) : null;
  return candidate ? { ...candidate, source: 'website_contact_page', sourceUrl: contactUrl } : null;
}

/**
 * Explicit, one-optional-page backfill path. It never invokes a reader or an
 * LLM: at most the restaurant homepage and one same-domain Contact page are
 * fetched with normal HTTP. The caller decides whether to run it in bulk.
 */
export async function findLocationOnWebsite(url: string): Promise<LocationCandidate | null> {
  const homepage = await fetchStaticHtml(url);
  if (!homepage) return null;
  const homepageCandidate = extractLocationFromHtml(homepage, url);
  if (homepageCandidate) return homepageCandidate;

  return findLocationOnContactPage(homepage, url);
}
