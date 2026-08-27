// Node builtins are NOT imported statically here. lib/url-guard is reachable
// from lib/scraper → lib/init-dublin → instrumentation.ts, and instrumentation
// is compiled for the Edge runtime as well as Node — where `node:dns` does not
// exist and the build fails outright. The webpackIgnore hint below keeps the
// import a real runtime import that webpack never tries to bundle; the Edge
// build therefore never resolves it, and nothing on that runtime calls it.
async function dnsLookupAll(host: string): Promise<{ address: string }[]> {
  const dns = await import(/* webpackIgnore: true */ 'node:dns/promises');
  return dns.lookup(host, { all: true });
}

/**
 * IP-literal family detection, in plain JS rather than `node:net` — same
 * reasoning as above, and the check is simple enough not to need a builtin.
 * Returns 4, 6, or 0 for "not an IP literal".
 */
export function ipFamily(value: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.').map(Number);
    return octets.every((n) => n >= 0 && n <= 255) ? 4 : 0;
  }
  // A URL hostname never contains a colon (the port is a separate field, and
  // IPv6 literals arrive bracketed and are unwrapped by the caller), so a
  // colon here means an IPv6 literal.
  if (value.includes(':')) return 6;
  return 0;
}

/**
 * SSRF protection for every outbound fetch of a URL we did not choose.
 *
 * The scraper is handed URLs by anonymous visitors (`POST /api/parse/discover`
 * takes `{ url }`) and by the LLM when it resolves a restaurant homepage. Both
 * are untrusted: without this, someone can point the server at hosts only it
 * can reach — cloud metadata endpoints, private RFC1918 ranges, localhost —
 * and use the app as an anonymous port scanner.
 *
 * `/api/parse/analyze` already avoids this by resolving stored candidate IDs
 * rather than accepting a URL; this closes the remaining paths.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// Anything else is a service we have no business reaching from a scraper.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * True for addresses that are not routable on the public internet.
 * Covers the ranges an SSRF is actually aimed at, in both IP families.
 */
export function isPrivateAddress(ip: string): boolean {
  const type = ipFamily(ip);

  if (type === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0) return true;                      // "this network"
    if (a === 10) return true;                     // RFC1918
    if (a === 127) return true;                    // loopback
    if (a === 169 && b === 254) return true;       // link-local — AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true;       // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;         // IETF protocol assignments
    if (a >= 224) return true;                     // multicast + reserved + broadcast
    return false;
  }

  if (type === 6) {
    const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v6 === '::' || v6 === '::1') return true;  // unspecified, loopback
    if (v6.startsWith('fe80')) return true;        // link-local
    if (/^f[cd]/.test(v6)) return true;            // unique local (fc00::/7)
    if (v6.startsWith('ff')) return true;          // multicast
    // IPv4-mapped (::ffff:169.254.169.254) — unwrap and re-check.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // Not an IP literal at all — caller should have resolved it first.
  return true;
}

// One analysis hits the same host many times — the homepage, a dozen subpage
// links, then the PDFs. Resolving each one separately added a DNS round trip
// per fetch (and, for a host that does not resolve, a full NXDOMAIN wait per
// retry). A short TTL keeps the guard honest against rebinding while making
// the common case free.
const DNS_TTL_MS = 30_000;
const dnsCache = new Map<string, { at: number; addresses: { address: string }[] }>();

/** Test seam — clears the memo. */
export function resetDnsCache(): void {
  dnsCache.clear();
}

async function resolveCached(host: string): Promise<{ address: string }[]> {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.addresses;

  const addresses = await dnsLookupAll(host);
  dnsCache.set(host, { at: Date.now(), addresses });
  // Unbounded growth would be a slow leak in a long-lived server process.
  if (dnsCache.size > 500) {
    // forEach rather than for..of: the project's tsconfig target needs
    // downlevelIteration to iterate a Map directly.
    const now = Date.now();
    dnsCache.forEach((v, k) => {
      if (now - v.at >= DNS_TTL_MS) dnsCache.delete(k);
    });
  }
  return addresses;
}

/**
 * Validate a URL and confirm every address it resolves to is public.
 *
 * Resolves DNS and checks ALL returned addresses: a hostname that answers with
 * both a public and a private address would otherwise pass on the first one.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('That does not look like a valid web address.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError('Only http and https addresses can be read.');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new BlockedUrlError('That address uses a port we do not read.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // An IP literal needs no DNS round trip.
  if (ipFamily(host)) {
    if (isPrivateAddress(host)) {
      throw new BlockedUrlError('That address is not publicly reachable.');
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await resolveCached(host);
  } catch {
    // A name that does not resolve is not an SSRF risk: there is no address to
    // reach, and fetch() will fail on the same resolver a moment later with a
    // more accurate error. Blocking here would only convert a real network
    // error into a misleading "not publicly reachable".
    return url;
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError('That address is not publicly reachable.');
    }
  }

  return url;
}

const MAX_REDIRECTS = 5;

/**
 * fetch() that re-validates the target on every redirect hop.
 *
 * Checking only the initial URL is defeated by a public host that 302s to
 * 169.254.169.254, and by DNS rebinding. `redirect: 'manual'` puts us in
 * control of each hop so the guard runs again before we follow it.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  opts: { alreadyValidated?: boolean } = {}
): Promise<Response> {
  // `alreadyValidated` lets a caller that validates once outside a retry loop
  // avoid re-resolving the same host on every attempt. Redirect hops are still
  // checked below regardless — that is the part that cannot be hoisted.
  let target = opts.alreadyValidated ? raw : (await assertPublicUrl(raw)).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(target, { ...init, redirect: 'manual' });

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
    if (!isRedirect) return res;

    const location = res.headers.get('location')!;
    // Relative Locations are resolved against the hop we are on.
    const next = new URL(location, target).toString();
    await assertPublicUrl(next);
    target = next;
  }

  throw new BlockedUrlError('That website redirected too many times.');
}
