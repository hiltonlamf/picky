// Unit tests for the new Google Maps name-extraction + web-search fallback logic.
import * as cheerio from 'cheerio';

let pass = 0; let fail = 0;
function ok(label: string, val: boolean) {
  if (val) { console.log('  ✓ ' + label); pass++; }
  else { console.error('  ✗ FAIL: ' + label); fail++; }
}

// ── replicate the helpers under test ──────────────────────────────────────────
function extractPlaceNameFromMapsUrl(mapsUrl: string): string | null {
  try {
    let target = mapsUrl;
    const u = new URL(mapsUrl);
    const cont = u.searchParams.get('continue');
    if (cont) target = decodeURIComponent(cont);
    const m = target.match(/\/maps\/place\/([^/@]+)/);
    if (!m?.[1]) return null;
    const name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    return name.length > 1 ? name : null;
  } catch { return null; }
}

function extractCoordsFromMapsUrl(mapsUrl: string): { lat: string; lon: string } | null {
  try {
    let target = mapsUrl;
    const u = new URL(mapsUrl);
    const cont = u.searchParams.get('continue');
    if (cont) target = decodeURIComponent(cont);
    const m = target.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!m) return null;
    return { lat: m[1], lon: m[2] };
  } catch { return null; }
}

// DDG result parsing (mirrors searchWebForRestaurantWebsite's parse step)
const NON = ['google.com','instagram.com','facebook.com','tripadvisor.com','deliveroo.','yelp.com'];
function isRestaurantWebsite(c: string, add: string[] = []): boolean {
  try {
    const u = new URL(c);
    if (!u.hostname.includes('.')) return false;
    if ([...NON, ...add].some(x => c.toLowerCase().includes(x))) return false;
    return true;
  } catch { return false; }
}
function parseDdg(html: string): string | null {
  const $ = cheerio.load(html);
  const candidates: string[] = [];
  $('a.result__a, a.result__url').each((_, el) => {
    let href = $(el).attr('href') ?? '';
    if (!href) return;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) href = decodeURIComponent(uddg[1]);
    else if (href.startsWith('//')) href = 'https:' + href;
    if (isRestaurantWebsite(href)) candidates.push(href);
  });
  return candidates[0] ?? null;
}

// ── tests ─────────────────────────────────────────────────────────────────────
console.log('\n=== Place name extraction ===');
ok('extracts "Uno Mas" from place URL',
  extractPlaceNameFromMapsUrl('https://www.google.com/maps/place/Uno+Mas/@53.33,-6.26,17z/data=xyz') === 'Uno Mas');
ok('decodes %20 encoded name',
  extractPlaceNameFromMapsUrl('https://www.google.com/maps/place/Uno%20Mas/@53.33,-6.26,17z') === 'Uno Mas');
ok('extracts name from consent-wrapped URL',
  extractPlaceNameFromMapsUrl('https://consent.google.com/m?continue=' +
    encodeURIComponent('https://www.google.com/maps/place/The+Pig+and+Heifer/@51.5,-0.1,17z')) === 'The Pig and Heifer');
ok('returns null when no place segment',
  extractPlaceNameFromMapsUrl('https://www.google.com/maps/search/restaurants') === null);

console.log('\n=== Coordinate extraction ===');
const c1 = extractCoordsFromMapsUrl('https://www.google.com/maps/place/Uno+Mas/@53.3341,-6.2689,17z');
ok('extracts lat/lon: ' + JSON.stringify(c1), c1?.lat === '53.3341' && c1?.lon === '-6.2689');
const c2 = extractCoordsFromMapsUrl('https://consent.google.com/m?continue=' +
  encodeURIComponent('https://www.google.com/maps/place/X/@40.7128,-74.0060,15z'));
ok('extracts coords from consent-wrapped URL: ' + JSON.stringify(c2), c2?.lat === '40.7128' && c2?.lon === '-74.0060');

console.log('\n=== DuckDuckGo result parsing ===');
const ddgHtml = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.unomas.ie%2F&rut=abc">Uno Mas Dublin</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.tripadvisor.com%2FUno_Mas&rut=def">TripAdvisor</a>
</div>`;
ok('decodes uddg param and skips tripadvisor: ' + parseDdg(ddgHtml),
  parseDdg(ddgHtml) === 'https://www.unomas.ie/');

const ddgDirect = `<a class="result__a" href="https://www.restaurant.co.uk/">Direct</a>`;
ok('handles direct href: ' + parseDdg(ddgDirect), parseDdg(ddgDirect) === 'https://www.restaurant.co.uk/');

const ddgOnlyExcluded = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2Funomas">FB</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeliveroo.ie%2Funomas">Deliveroo</a>`;
ok('returns null when only social/delivery results: ' + parseDdg(ddgOnlyExcluded),
  parseDdg(ddgOnlyExcluded) === null);

console.log('\n=== Social og:title cleaning ===');
function cleanSocialTitle(t: string): string { return t.split(/[(|•·\-–]/)[0].trim(); }
ok('cleans Instagram og:title',
  cleanSocialTitle('Uno Mas (@unomasdublin) • Instagram photos and videos') === 'Uno Mas');
ok('cleans pipe-separated title',
  cleanSocialTitle('Uno Mas | Facebook') === 'Uno Mas');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
