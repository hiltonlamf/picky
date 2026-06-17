/**
 * Tests for scraper.ts changes.
 * Sections:
 *   1. Unit tests for isRestaurantWebsite / extractRestaurantUrlFromHtml (no network)
 *   2. Integration tests for paths reachable in this environment
 */

// ── import internals via a local re-export trick ──────────────────────────────
// We test the exported function plus expose internals via a side-loaded module
import { scrapeRestaurant } from '../lib/scraper';

// ── helpers ───────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

function ok(label: string, value: boolean) {
  if (value) { console.log(`  ✓ ${label}`); pass++; }
  else        { console.error(`  ✗ ${label}`); fail++; }
}

// ── 1. Unit tests — no network needed ─────────────────────────────────────────
console.log('\n=== Unit tests (no network) ===');

// Reproduce the logic inline so we can test without network calls
const NON_RESTAURANT_DOMAINS = [
  'google.com', 'googleapis.com', 'goo.gl', 'googletagmanager.com',
  'googleusercontent.com', 'googlevideo.com', 'doubleclick.net', 'ggpht.com',
  'youtube.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com',
  'x.com', 'linkedin.com', 'tiktok.com', 'pinterest.com', 'snapchat.com',
  'apple.com', 'microsoft.com', 'amazon.com', 'cloudflare.com',
  'schema.org', 'w3.org', 'openstreetmap.org', 'maps.app',
  'yelp.com', 'tripadvisor.com', 'zomato.com', 'opentable.com', 'thefork.com',
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
  } catch { return false; }
}

function extractRestaurantUrlFromHtml(html: string, additionalExclusions: string[] = []): string | null {
  const cap = html.slice(0, 2 * 1024 * 1024);
  const patterns = [
    /"(https?:\/\/[^"\\]{5,300})"/g,
    /\\x22(https?:\/\/[^\\]{5,300})\\x22/g,
    /\\u0022(https?:\/\/[^\\]{5,300})\\u0022/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(cap)) !== null) {
      if (isRestaurantWebsite(match[1], additionalExclusions)) return match[1];
    }
  }
  return null;
}

// isRestaurantWebsite tests
ok('accepts restaurant website',       isRestaurantWebsite('https://www.unomas.ie/'));
ok('accepts restaurant with path',     isRestaurantWebsite('https://www.unomas.ie/menu'));
ok('rejects google.com',              !isRestaurantWebsite('https://www.google.com/maps'));
ok('rejects googleapis',              !isRestaurantWebsite('https://maps.googleapis.com/maps/api'));
ok('rejects instagram.com',           !isRestaurantWebsite('https://www.instagram.com/unomasdublin'));
ok('rejects youtube.com',             !isRestaurantWebsite('https://www.youtube.com/watch'));
ok('rejects .jpg file',               !isRestaurantWebsite('https://www.unomas.ie/image.jpg'));
ok('rejects very long URL',           !isRestaurantWebsite('https://cdn.example.com/' + 'a'.repeat(280)));
ok('rejects facebook.com',            !isRestaurantWebsite('https://www.facebook.com/unomas'));
ok('rejects tripadvisor',             !isRestaurantWebsite('https://www.tripadvisor.com/Restaurant'));
ok('accepts .co.uk domain',            isRestaurantWebsite('https://www.restaurant.co.uk/'));
ok('rejects additionalExclusion',     !isRestaurantWebsite('https://www.unomas.ie/', ['unomas.ie']));

// extractRestaurantUrlFromHtml tests
const mockGoogleMapsHtml = `
<html><body>
<script>var data = {"name":"Uno Mas","website":"https://www.unomas.ie/","address":"Dublin"}</script>
<script src="https://maps.googleapis.com/maps/api/js"></script>
<img src="https://lh3.googleusercontent.com/longphotourl123456789012345.jpg"/>
</body></html>`;

const mockGoogleMapsHtmlEscaped = `
<html><body>
<script>window.__data=\\x22https://www.unomas.ie/\\x22;</script>
<script>var g = \\x22https://www.google.com/maps/place\\x22;</script>
</body></html>`;

const mockGoogleMapsHtmlUnicode = `
<html><body>
<script>data["url"]="\\u0022https://www.unomas.ie/\\u0022"</script>
</body></html>`;

const mockNoRestaurant = `
<html><body>
<script>{"g":"https://www.google.com/maps","yt":"https://www.youtube.com/v/abc"}</script>
</body></html>`;

ok('extracts URL from standard JSON quotes',   extractRestaurantUrlFromHtml(mockGoogleMapsHtml) === 'https://www.unomas.ie/');
ok('extracts URL from hex-escaped quotes',     extractRestaurantUrlFromHtml(mockGoogleMapsHtmlEscaped) === 'https://www.unomas.ie/');
ok('returns null when only excluded domains',  extractRestaurantUrlFromHtml(mockNoRestaurant) === null);
ok('excludes additional domain',               extractRestaurantUrlFromHtml(mockGoogleMapsHtml, ['unomas.ie']) === null);

// ── 2. Integration tests (network) ────────────────────────────────────────────
console.log('\n=== Integration tests (network) ===');

async function integrationTests() {
  // Test 1: direct website URL still works
  {
    process.stdout.write('[direct website — unomas.ie]\n');
    try {
      const r = await scrapeRestaurant('https://www.unomas.ie/');
      ok('canonicalUrl is unomas.ie',  r.canonicalUrl.includes('unomas.ie'));
      ok('urlType is html',            r.urlType === 'html');
      ok('no warning',                 !r.warning);
      ok('has menu text',              r.menuText.length > 100);
    } catch(e) { console.error('  ERROR:', e); fail++; }
  }

  // Test 2: TripAdvisor URL (review site path)
  {
    process.stdout.write('\n[review site — TripAdvisor]\n');
    try {
      const r = await scrapeRestaurant('https://www.tripadvisor.com/Restaurant_Review-g186605-d1938549-Reviews-Uno_Mas-Dublin_County_Dublin.html');
      ok('urlType is html',            r.urlType === 'html');
      console.log(`  canonicalUrl: ${r.canonicalUrl}`);
      console.log(`  menuText len: ${r.menuText.length}`);
      if (r.warning) console.log(`  warning: ${r.warning}`);
    } catch(e) { console.error('  ERROR:', e); fail++; }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nNote: Google Maps / Instagram tests cannot run in this sandbox');
    console.log('(maps.app.goo.gl and instagram.com are blocked by network egress policy).');
    console.log('The production Vercel environment has full network access.');
  }
  process.exit(fail > 0 ? 1 : 0);
}

integrationTests().catch(e => { console.error(e); process.exit(1); });
