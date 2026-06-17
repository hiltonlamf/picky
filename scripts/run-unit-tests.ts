// Quick unit tests for the scraper logic (no network needed)
const NON_RESTAURANT_DOMAINS = [
  'google.com', 'google.ie', 'google.co.uk', 'googleapis.com', 'goo.gl',
  'googletagmanager.com', 'googleusercontent.com', 'googlevideo.com',
  'doubleclick.net', 'ggpht.com', 'maps.app',
  'youtube.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com',
  'x.com', 'linkedin.com', 'tiktok.com', 'pinterest.com', 'snapchat.com',
  'apple.com', 'microsoft.com', 'amazon.com', 'cloudflare.com',
  'schema.org', 'w3.org', 'openstreetmap.org', 'w3schools.com',
  'yelp.com', 'tripadvisor.com', 'zomato.com', 'opentable.com', 'thefork.com',
  'happycow.net', 'foursquare.com', 'lovin.ie', 'timeout.com',
  'deliveroo.', 'ubereats.com', 'just-eat.', 'doordash.com',
  'grubhub.com', 'seamless.com', 'menulog.', 'hungryhouse.',
  'wolt.com', 'bolt.eu', 'flipdish.',
  'resdiary.com', 'resdiary.net', 'quandoo.com', 'bookatable.com',
  'sevenrooms.com', 'resy.com', 'booking.com', 'toasttab.com',
  'tock.com', 'eatwith.com', 'diningout.ie',
  'order.bar', 'bopple.com', 'square.site', 'squareup.com',
  'linktr.ee', 'linktree.com', 'beacons.ai', 'bio.site', 'campsite.bio',
];
const NON_RESTAURANT_EXTENSIONS = ['.jpg','.jpeg','.png','.gif','.webp','.svg','.ico','.css','.js','.woff','.woff2'];

function isRestaurantWebsite(candidate: string, add: string[] = []): boolean {
  try {
    const u = new URL(candidate);
    const lower = candidate.toLowerCase();
    if (!u.hostname.includes('.')) return false;
    if ([...NON_RESTAURANT_DOMAINS, ...add].some(ex => lower.includes(ex))) return false;
    const path = u.pathname.toLowerCase();
    if (NON_RESTAURANT_EXTENSIONS.some(ext => path.endsWith(ext))) return false;
    if (candidate.length > 300) return false;
    return true;
  } catch { return false; }
}

function scoreAsRestaurantHomepage(url: string): number {
  try {
    const u = new URL(url);
    let score = 100;
    const pathDepth = u.pathname.split('/').filter(Boolean).length;
    score -= pathDepth * 20;
    if (u.search) score -= 40;
    if (u.hash) score -= 10;
    score -= Math.floor(url.length / 15);
    return score;
  } catch { return -999; }
}

function extractRestaurantUrlFromHtml(html: string, add: string[] = []): string | null {
  let cap = html.slice(0, 2 * 1024 * 1024);
  cap = cap.replace(/\\\//g, '/');

  const mapsPatterns = [
    /website_uri[^"]{0,30}"(https?:\/\/[^"\\]+)"/,
    /"website"\s*:\s*"(https?:\/\/[^"\\]+)"/,
    /"primaryUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/,
    /\["(https?:\/\/[^"\\]+)",null,null,null/,
    /\["(https?:\/\/[^"\\]+)",null,null\]/,
    /externalLinks[^[]{0,50}\["(https?:\/\/[^"\\]+)"/,
  ];
  for (const p of mapsPatterns) {
    const m = cap.match(p);
    if (m?.[1] && isRestaurantWebsite(m[1], add)) return m[1];
  }

  const pattern = /"(https?:\/\/[^"\\]{5,300})"/g;
  const candidates: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(cap)) !== null) {
    const u = match[1];
    if (!seen.has(u) && isRestaurantWebsite(u, add)) {
      seen.add(u);
      candidates.push(u);
      if (candidates.length >= 60) break;
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => scoreAsRestaurantHomepage(b) - scoreAsRestaurantHomepage(a));
  return candidates[0];
}

let pass = 0; let fail = 0;
function ok(label: string, val: boolean) {
  if (val) { console.log('  ✓ ' + label); pass++; }
  else { console.error('  ✗ FAIL: ' + label); fail++; }
}

console.log('\n=== Exclusion tests ===');
ok('accepts unomas.ie', isRestaurantWebsite('https://www.unomas.ie/'));
ok('rejects deliveroo.ie', !isRestaurantWebsite('https://deliveroo.ie/restaurants/dublin/uno-mas'));
ok('rejects deliveroo.com', !isRestaurantWebsite('https://deliveroo.com/menu/resto'));
ok('rejects resdiary.com', !isRestaurantWebsite('https://resdiary.com/restaurant/unomas'));
ok('rejects just-eat.ie', !isRestaurantWebsite('https://www.just-eat.ie/restaurants/uno-mas'));
ok('rejects menulog.ie', !isRestaurantWebsite('https://www.menulog.ie/menu'));
ok('rejects google.ie', !isRestaurantWebsite('https://www.google.ie/maps'));
ok('rejects google.com', !isRestaurantWebsite('https://www.google.com/maps'));
ok('accepts .co.uk domain', isRestaurantWebsite('https://www.somerestaurant.co.uk/'));

console.log('\n=== Scoring tests ===');
const unomasScore = scoreAsRestaurantHomepage('https://www.unomas.ie/');
const deepPath = scoreAsRestaurantHomepage('https://example.ie/a/b/c/d/menu');
const withQuery = scoreAsRestaurantHomepage('https://example.ie/reserve?date=2024-01-01&party=2');
console.log('  unomas.ie/ score:', unomasScore);
console.log('  deep path score:', deepPath);
console.log('  with query score:', withQuery);
ok('root URL scores higher than deep path', unomasScore > deepPath);
ok('root URL scores higher than URL with query string', unomasScore > withQuery);

console.log('\n=== URL extraction tests ===');

// Standard JSON
const stdJson = '{"name":"Uno Mas","website":"https://www.unomas.ie/","type":"Restaurant"}';
const r1 = extractRestaurantUrlFromHtml(stdJson);
ok('extracts from standard JSON "website": ' + r1, r1 === 'https://www.unomas.ie/');

// website_uri pattern (Google Maps internal field)
const websiteUri = 'af_initData({website_uri:"https://www.unomas.ie/"})';
const r2 = extractRestaurantUrlFromHtml(websiteUri);
ok('extracts from website_uri pattern: ' + r2, r2 === 'https://www.unomas.ie/');

// Backslash-escaped slashes (Google Maps JSON format) — KEY FIX in iteration 2
// In the raw HTML, Google encodes "/" as "\/" so "https://www.unomas.ie/" appears as "https:\/\/www.unomas.ie\/"
const escapedSlashes = '{"data":"https:\\/\\/www.unomas.ie\\/"}';
const r3 = extractRestaurantUrlFromHtml(escapedSlashes);
ok('extracts URL with \\\\/  escaped slashes (Google Maps format): ' + r3, r3 === 'https://www.unomas.ie/');

// Array format (Maps nested data)
const arrayFmt = '["https://www.unomas.ie/",null,null,null]';
const r4 = extractRestaurantUrlFromHtml(arrayFmt);
ok('extracts from array format ["url",null,null,null]: ' + r4, r4 === 'https://www.unomas.ie/');

// Scoring picks root URL over deep path
const mixedUrls = '["https://www.unomas.ie/reserve/table/2024/01","https://www.unomas.ie/"]';
const r5 = extractRestaurantUrlFromHtml(mixedUrls);
ok('scoring picks root URL over deep path: ' + r5, r5 === 'https://www.unomas.ie/');

// Excludes delivery platforms even if they appear first
const deliverooFirst = '["https://deliveroo.ie/restaurants/uno-mas","https://www.unomas.ie/"]';
const r6 = extractRestaurantUrlFromHtml(deliverooFirst);
ok('excludes deliveroo.ie and finds real site: ' + r6, r6 === 'https://www.unomas.ie/');

// Returns null when only excluded domains
const onlyExcluded = '{"g":"https://www.google.com/maps","yt":"https://www.youtube.com/watch"}';
const r7 = extractRestaurantUrlFromHtml(onlyExcluded);
ok('returns null when only excluded domains: ' + r7, r7 === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
