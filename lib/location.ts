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
  label?: string;
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

const DUBLIN_EIRCODE_SOURCE = '(?:D(?:0[1-9]|1\\d|2[0-4])|D6W)\\s*[A-Z0-9]{4}';
const DUBLIN_EIRCODE_RE = new RegExp(`\\b${DUBLIN_EIRCODE_SOURCE}\\b`, 'i');

function eircodeKey(address: string): string | null {
  return address.match(DUBLIN_EIRCODE_RE)?.[0].replace(/\s+/g, '').toUpperCase() ?? null;
}

function collapseRepeatedSuffixWords(value: string): string {
  const words = value.split(/\s+/);
  for (let width = Math.floor(words.length / 2); width >= 2; width -= 1) {
    const first = words.slice(words.length - width * 2, words.length - width);
    const second = words.slice(words.length - width);
    if (first.every((word, index) => word.toLowerCase() === second[index]?.toLowerCase())) {
      return words.slice(0, words.length - width).join(' ');
    }
  }
  return value;
}

/** Clean first-party postal text without inventing or geocoding an address. */
export function cleanPublishedAddress(value: string): string {
  let compact = value
    .replace(/\s+/g, ' ')
    .replace(/^(?:address|location|地址)\s*[-—:：]?\s*/i, '')
    .trim();

  // Map labels sometimes prefix the postal address with a venue/page title.
  // Keep from the first numbered street only when the discarded text clearly
  // describes a restaurant/menu label rather than a unit or building name.
  const street = compact.match(NUMBERED_STREET_RE);
  if (street?.index && /restaurant|restaruant|menu|location/i.test(compact.slice(0, street.index))) {
    compact = compact.slice(street.index);
  }

  const eircode = compact.match(DUBLIN_EIRCODE_RE)?.[0];
  if (eircode) {
    const formatted = `${eircode.replace(/\s+/g, '').slice(0, 3).toUpperCase()} ${eircode.replace(/\s+/g, '').slice(3).toUpperCase()}`;
    compact = compact.replace(DUBLIN_EIRCODE_RE, formatted);
    // Insert the missing separator used by compact blocks such as
    // "100 Parnell Street D01A7P8".
    compact = compact.replace(new RegExp(`(?<![,\\s])\\s*(${DUBLIN_EIRCODE_SOURCE})`, 'i'), ', $1');
  }

  const parts: string[] = [];
  let country: string | null = null;
  for (const rawPart of compact.split(/\s*,\s*/)) {
    const part = collapseRepeatedSuffixWords(rawPart.trim());
    if (!part) continue;
    const key = addressKey(part);
    if (/^(?:ie|ireland)$/i.test(part) && eircode) {
      country ??= /^ie$/i.test(part) ? 'IE' : 'Ireland';
      continue;
    }
    if (parts.some((stored) => addressKey(stored) === key)) continue;
    const previous = parts.at(-1);
    // "100 Parnell Street, Parnell Street" is one street, not two branches.
    if (previous && STREET_TYPE_RE.test(part) && addressKey(previous).endsWith(` ${key}`)) continue;
    parts.push(part);
  }
  if (country) parts.push(country);
  return parts.join(', ');
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
      ...(text(item.name) ? { label: text(item.name)! } : {}),
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
const VISIBLE_EIRCODE_RE = new RegExp(`\\b${DUBLIN_EIRCODE_SOURCE}\\b`, 'i');
// Keep Dutch postcode letters case-sensitive so ordinary prose such as
// "from 2016 to 2019" cannot become a bogus address. Lowercase address blocks
// that include Amsterdam still use the street-and-city fallback below.
const VISIBLE_DUTCH_POSTCODE_RE = /\b\d{4}\s?[A-Z]{2}\b/;
const VISIBLE_CITY_RE = /\b(?:Dublin(?:\s+\d{1,2})?|Amsterdam|London|Westport)\b/i;
const STREET_TYPES = 'street|st\\.?|road|rd\\.?|row|court|square|quay|lane|place|terrace|buildings?|avenue|boulevard|straat|gracht|kade|plein|weg|dijk|markt|rue|quai|via|viale|piazza|calle|carrer|paseo|platz|strasse|straße|chaussee|chaussée|rua|travessa';
const STREET_TYPE_RE = new RegExp(`\\b(?:${STREET_TYPES})\\b`, 'i');
const NUMBERED_STREET_RE = new RegExp(`\\b\\d+[A-Z]?(?:[-/]\\d+[A-Z]?)?(?:\\s+[^\\s,]+){0,6}\\s+(?:${STREET_TYPES})\\b`, 'i');

function addressesFromVisibleText($: cheerio.CheerioAPI, sourceUrl: string): LocationCandidate[] {
  const candidates: LocationCandidate[] = [];
  for (const element of $('address, [itemprop="address"], [class*="address"], [class*="Address"], [id*="address"], [id*="Address"], p, li, h1, h2, h3, h4, h5, h6').toArray()) {
    const copy = $(element).clone();
    copy.find('script, style, svg').remove();
    const hadLineBreak = copy.find('br').length > 0;
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
    const postcode = value.match(VISIBLE_EIRCODE_RE) ?? value.match(VISIBLE_DUTCH_POSTCODE_RE);
    const city = value.match(VISIBLE_CITY_RE);
    const beforeCity = city?.index === undefined ? '' : value.slice(0, city.index);
    const attributes = [$(element).attr('class'), $(element).attr('id'), $(element).attr('itemprop'), $(element).attr('aria-label')]
      .filter(Boolean)
      .join(' ');
    const labelledAddress = /address/i.test(attributes) || /^address\s*:?/i.test(value);
    const hasStreetAddress = NUMBERED_STREET_RE.test(beforeCity);
    // Some legitimate city-centre addresses have no street number (for
    // example "Fade Street, Dublin 2"), while a labelled venue address may
    // use a building or suburb name ("53 Ranelagh, Dublin 6"). Keep this
    // fallback short and require the address portion to precede the city.
    const hasCompactAddress = value.length <= 140 && (
      STREET_TYPE_RE.test(beforeCity) || (labelledAddress && /\d/.test(beforeCity))
    );
    const context = [
      attributes,
      $(element).parent().attr('class'),
      $(element).parent().attr('id'),
      $(element).closest('footer').length ? 'footer' : '',
    ].filter(Boolean).join(' ');
    // Country-independent fallback: an explicitly labelled/contact/footer
    // block containing a numbered street can be accepted without knowing the
    // city's postcode format in advance. A line break is strong address-layout
    // evidence; ordinary promotional prose on an unlabelled single line is not.
    const genericStreetAddress = value.length <= 180 && NUMBERED_STREET_RE.test(value) &&
      (labelledAddress || hadLineBreak || /contact|location|visit|footer/i.test(context));
    if (
      value.length < 8 ||
      value.length > 260 ||
      ((!postcode || postcode.index === undefined) &&
        (!city || city.index === undefined || (!hasStreetAddress && !hasCompactAddress)) &&
        !genericStreetAddress)
    ) continue;
    const postcodeEnd = postcode && postcode.index !== undefined ? postcode.index + postcode[0].length : 0;
    const cityEnd = city && city.index !== undefined ? city.index + city[0].length : 0;
    const end = Math.max(postcodeEnd, cityEnd) || value.length;
    candidates.push({
      // A footer can place the email/telephone immediately after an Eircode
      // without a \"Phone\" label. The postcode is the trusted end of the
      // address, so do not display whatever follows it.
      address: value.slice(0, end).replace(/^address\s*:?\s*/i, '').trim(),
      confidence: 'medium',
      source: 'website_address_element',
      sourceUrl,
    });
  }
  return candidates;
}

function addressesFromMetadata($: cheerio.CheerioAPI, sourceUrl: string): LocationCandidate[] {
  const candidates: LocationCandidate[] = [];
  const title = $('title').first().text();
  const city = title.match(/\bDublin(?:\s+\d{1,2})?\b/i)?.[0] ?? null;
  for (const element of $('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]').toArray()) {
    const description = text($(element).attr('content'));
    if (!description) continue;
    const match = description.match(/\b(?:located|based|find us)\s+(?:at|on)\s+([^.!?]{5,140})/i);
    if (!match || !NUMBERED_STREET_RE.test(match[1])) continue;
    let address = match[1].trim();
    if (city && !/\bDublin\b/i.test(address)) address = `${address}, ${city}`;
    candidates.push({
      address,
      confidence: 'medium',
      source: 'website_address_element',
      sourceUrl,
    });
  }
  return candidates;
}

const LOCATION_CONFIDENCE_RANK: Record<LocationConfidence, number> = { low: 1, medium: 2, high: 3 };

function addressKey(address: string): string {
  return address.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function areAddressesEquivalent(left: string, right: string): boolean {
  const leftEircode = eircodeKey(left);
  const rightEircode = eircodeKey(right);
  if (leftEircode && rightEircode && leftEircode === rightEircode) return true;
  const a = addressKey(left);
  const b = addressKey(right);
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // The same official address often appears once without its postcode/country
  // and once with them. A meaningful whole-address prefix is safe to merge;
  // differing street numbers do not satisfy this check.
  return shorter.length >= 12 && (longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`));
}

function isUsablePublishedAddress(address: string): boolean {
  const compact = address.replace(/\s+/g, ' ').trim();
  // Reject broken schema/map labels such as "D, IE" or a venue name alone.
  // A real postal address almost always carries a building/street/postal number;
  // numberless street names are still accepted when the city district supplies
  // one (e.g. "Fade Street, Dublin 2").
  return compact.length >= 8 && compact.length <= 300 && /\d/.test(compact) && /[A-Za-z]{2}/.test(compact);
}

/** Prefer stronger duplicate evidence while retaining coordinates and a branch label. */
export function dedupeLocationCandidates(candidates: LocationCandidate[]): LocationCandidate[] {
  const byAddress = new Map<string, LocationCandidate>();
  const coordinatesOnly: LocationCandidate[] = [];
  for (const originalCandidate of candidates) {
    const candidate = originalCandidate.address
      ? { ...originalCandidate, address: cleanPublishedAddress(originalCandidate.address) }
      : originalCandidate;
    if (candidate.address && !isUsablePublishedAddress(candidate.address)) continue;
    const key = addressKey(candidate.address);
    if (!key) {
      if (candidate.latitude !== undefined && candidate.longitude !== undefined) coordinatesOnly.push(candidate);
      continue;
    }
    const equivalentKey = Array.from(byAddress.keys()).find((storedKey) =>
      areAddressesEquivalent(storedKey, key)
    );
    const existing = equivalentKey ? byAddress.get(equivalentKey) : undefined;
    if (!existing) {
      byAddress.set(key, candidate);
      continue;
    }
    const stronger = LOCATION_CONFIDENCE_RANK[candidate.confidence] > LOCATION_CONFIDENCE_RANK[existing.confidence] ||
      (candidate.confidence === existing.confidence && candidate.address.length > existing.address.length)
      ? candidate
      : existing;
    const other = stronger === candidate ? existing : candidate;
    if (equivalentKey && equivalentKey !== key) byAddress.delete(equivalentKey);
    byAddress.set(addressKey(stronger.address), {
      ...stronger,
      ...(stronger.label || !other.label ? {} : { label: other.label }),
      ...(stronger.latitude !== undefined || other.latitude === undefined
        ? {}
        : { latitude: other.latitude, longitude: other.longitude }),
    });
  }
  return [...Array.from(byAddress.values()), ...coordinatesOnly];
}

function specificPageLocationHint(sourceUrl: string): string | null {
  try {
    const slug = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!slug || /^(?:home|index|contact|about|menu|menus|location|locations|find us|visit us|info|hours|splash|restaurant)$/i.test(slug)) {
      return null;
    }
    return addressKey(slug).length >= 4 ? slug : null;
  } catch {
    return null;
  }
}

/** Extract every address a restaurant deliberately publishes on its own page. */
export function extractLocationsFromHtml(html: string, sourceUrl: string): LocationCandidate[] {
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
  const addressElements: LocationCandidate[] = [];
  $('address').each((_, element) => {
    const address = $(element).text().replace(/\s+/g, ' ').trim();
    if (address.length >= 8 && address.length <= 300) {
      addressElements.push({ address, confidence: 'high', source: 'website_address_element', sourceUrl });
    }
  });

  let published = dedupeLocationCandidates([
    ...structured,
    ...addressElements,
    ...addressesFromMetadata($, sourceUrl),
    ...addressesFromVisibleText($, sourceUrl),
    ...mapCandidates.filter((candidate) => candidate.address),
  ]);

  // A group site may list every sister venue in a shared footer. On a specific
  // branch page, prefer the address that names the page slug (for example,
  // /orwell-road -> "8 Orwell Road") instead of publishing every footer card.
  const pageHint = specificPageLocationHint(sourceUrl);
  if (published.length > 1 && pageHint) {
    const hintKey = addressKey(pageHint);
    const matching = published.filter((candidate) =>
      addressKey(`${candidate.label ?? ''} ${candidate.address}`).includes(hintKey)
    );
    if (matching.length) published = matching;
  }

  // A page with exactly one published address and one coordinate-only map link
  // unambiguously describes the same venue. With several branches we never
  // guess which pin belongs to which address.
  const mapCoordinates = mapCandidates.filter(
    (candidate) => !candidate.address && candidate.latitude !== undefined && candidate.longitude !== undefined
  );
  if (published.length === 1 && mapCoordinates.length === 1 && published[0].latitude === undefined) {
    published = [{
      ...published[0],
      latitude: mapCoordinates[0].latitude,
      longitude: mapCoordinates[0].longitude,
    }];
  }
  if (published.length) return published;
  // Coordinates without a published street address may support local polygon
  // matching, but they are never rendered as an invented address.
  return mapCoordinates.slice(0, 1);
}

/** Backward-compatible single-location view for existing callers. */
export function extractLocationFromHtml(html: string, sourceUrl: string): LocationCandidate | null {
  return extractLocationsFromHtml(html, sourceUrl)[0] ?? null;
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

function contactPageUrls(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const page = new URL(pageUrl);
  const candidates: Array<{ url: string; priority: number }> = [];
  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href') ?? '';
    const label = `${$(element).text()} ${href}`.toLowerCase();
    if (!/(contact|about|info|hours|splash|find[-_ ]?us|location|visit[-_ ]?us)/.test(label)) continue;
    try {
      const target = new URL(href, pageUrl);
      // Never use a directory/social profile as alleged first-party evidence.
      const sameFirstPartyHost = target.hostname.replace(/^www\./i, '') === page.hostname.replace(/^www\./i, '');
      if (sameFirstPartyHost && target.protocol.startsWith('http')) {
        candidates.push({
          url: target.href,
          priority: /(contact|info|hours|find[-_ ]?us|location|visit[-_ ]?us)/.test(label) ? 0 : 1,
        });
      }
    } catch {
      // Continue scanning a malformed link.
    }
  }
  return Array.from(new Map(
    candidates.sort((a, b) => a.priority - b.priority).map((candidate) => [candidate.url, candidate.url])
  ).values()).slice(0, 3);
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
        'User-Agent': 'Platefully location verifier (+https://platefully.vercel.app)',
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
 * make only bounded, conditional same-domain location-page requests needed to
 * find a published address. This deliberately avoids reader or model requests
 * on the normal parse path.
 */
export async function findLocationOnContactPage(homepageHtml: string, pageUrl: string): Promise<LocationCandidate | null> {
  return (await findLocationsOnContactPages(homepageHtml, pageUrl))[0] ?? null;
}

/** Read every linked first-party contact/location page and retain every branch. */
export async function findLocationsOnContactPages(homepageHtml: string, pageUrl: string): Promise<LocationCandidate[]> {
  // These are independent same-site pages. Serial 12-second budgets meant a
  // dead Contact link could delay an otherwise healthy menu by up to 36s.
  // Promise.all preserves URL order, so the preferred-address behavior stays
  // deterministic while wall time is bounded by the slowest page, not the sum.
  const pages = await Promise.all(
    contactPageUrls(homepageHtml, pageUrl).map(async (contactUrl) => ({
      contactUrl,
      html: await fetchStaticHtml(contactUrl),
    }))
  );
  const candidates = pages.flatMap(({ contactUrl, html }) =>
    html
      ? extractLocationsFromHtml(html, contactUrl)
          .filter((candidate) => candidate.address)
          .map((candidate) => ({ ...candidate, source: 'website_contact_page' as const, sourceUrl: contactUrl }))
      : []
  );
  return dedupeLocationCandidates(candidates);
}

/**
 * Explicit, bounded backfill path. It never invokes a reader or an LLM: the
 * restaurant homepage and at most three linked same-domain location pages are
 * fetched with normal HTTP. The caller decides whether to run it in bulk.
 */
export async function findLocationOnWebsite(url: string): Promise<LocationCandidate | null> {
  return (await findLocationsOnWebsite(url))[0] ?? null;
}

/** Multi-branch equivalent of findLocationOnWebsite. */
export async function findLocationsOnWebsite(url: string): Promise<LocationCandidate[]> {
  const homepage = await fetchStaticHtml(url);
  if (!homepage) return [];
  return dedupeLocationCandidates([
    ...extractLocationsFromHtml(homepage, url),
    ...await findLocationsOnContactPages(homepage, url),
  ]);
}
