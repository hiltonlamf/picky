import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

// `||` (not `??`) so an empty RATE_LIMIT_MAX_PER_HOUR ("") also falls back to
// the default instead of parsing to NaN. Exported so the user-facing error
// messages quote the real number instead of a hardcoded one.
export const MAX_SEARCHES_PER_HOUR = parseInt(process.env.RATE_LIMIT_MAX_PER_HOUR || '15', 10);
export const MAX_PLACE_AUTOCOMPLETE_PER_HOUR = parseInt(
  process.env.PLACE_AUTOCOMPLETE_MAX_PER_HOUR || '60',
  10
);
export const MAX_PLACE_DETAILS_PER_HOUR = parseInt(
  process.env.PLACE_DETAILS_MAX_PER_HOUR || '15',
  10
);

let _supabase: ReturnType<typeof createClient> | null = null;

// eslint-disable-next-line
function getSupabase(): any | null {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// The salt was hardcoded in a public repo, which made the hashes trivially
// reversible across the IPv4 space and undermined the "one-way hash" claim on
// the privacy page. It now comes from the environment; the old literal stays as
// the fallback so existing buckets keep matching until IP_HASH_SALT is set.
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'picky-salt-2024';

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip + IP_HASH_SALT).digest('hex').slice(0, 16);
}

/**
 * Checks the per-IP hourly search budget. `consume` (default true) records a
 * new event when allowed — pass `consume: false` to only *read* the budget
 * without spending a slot (used by the classify step, so one new-restaurant
 * flow costs a single slot even though it spans discover + analyze requests).
 */
export async function checkRateLimit(
  ip: string,
  opts: { consume?: boolean } = {}
): Promise<{ allowed: boolean; remaining: number }> {
  const consume = opts.consume ?? true;
  const sb = getSupabase();
  // FAIL CLOSED. This budget is the only thing bounding paid Anthropic calls
  // per visitor, so "we cannot count" must mean "no new paid work" — the old
  // behaviour returned `allowed: true` here and silently removed the cap for
  // everyone whenever Supabase was misconfigured or unreachable.
  if (!sb) return { allowed: false, remaining: 0 };

  const ipHash = hashIp(ip);
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  let requestCount: number | null = null;
  try {
    const result = await sb
      .from('rate_limit_events')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', windowStart);
    // supabase-js reports query failures on `error` rather than throwing, so
    // the catch below almost never fired — a failed count read as 0 and let
    // the request through. Treat either shape as "unknown".
    requestCount = result.error ? null : result.count ?? 0;
  } catch {
    requestCount = null;
  }

  if (requestCount === null) return { allowed: false, remaining: 0 };

  const allowed = requestCount < MAX_SEARCHES_PER_HOUR;
  const remaining = Math.max(0, MAX_SEARCHES_PER_HOUR - requestCount);

  if (allowed && consume) {
    try {
      await sb.from('rate_limit_events').insert({ ip_hash: ipHash });
    } catch {
      // non-critical
    }
  }

  return { allowed, remaining };
}

export async function checkPlaceLookupRateLimit(
  ip: string,
  kind: 'autocomplete' | 'details'
): Promise<{ allowed: boolean; remaining: number }> {
  const max = kind === 'autocomplete' ? MAX_PLACE_AUTOCOMPLETE_PER_HOUR : MAX_PLACE_DETAILS_PER_HOUR;
  const sb = getSupabase();
  if (!sb) return { allowed: true, remaining: max };
  const ipHash = hashIp(ip);
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const result = await sb
      .from('external_lookup_events')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .eq('kind', kind)
      .gte('created_at', windowStart);
    const count = result.count ?? 0;
    if (count >= max) return { allowed: false, remaining: 0 };
    await sb.from('external_lookup_events').insert({ ip_hash: ipHash, kind });
    return { allowed: true, remaining: Math.max(0, max - count - 1) };
  } catch {
    // Lookup is still usable during a migration/configuration outage. Google
    // Cloud quotas remain the hard project-wide protection.
    return { allowed: true, remaining: max };
  }
}

/**
 * The client IP used for every rate-limit bucket.
 *
 * SECURITY: never trust the *leftmost* `x-forwarded-for` entry. That header is
 * a caller-supplied list and Vercel's edge appends the true client IP to the
 * end of it rather than stripping what the caller sent — so reading `[0]` lets
 * anyone mint a fresh rate-limit bucket per request with
 * `X-Forwarded-For: 1.2.3.4`. That single bug bypassed both the AI-spend cap
 * and the admin-login brute-force throttle.
 *
 * Order of preference:
 *  1. `x-vercel-forwarded-for` — set by Vercel's edge, and inbound `x-vercel-*`
 *     headers are stripped, so a client cannot forge it.
 *  2. the RIGHTMOST `x-forwarded-for` hop — the entry appended by the closest
 *     trusted proxy. Everything to its left is caller-controlled.
 *  3. `x-real-ip`, then a local fallback for dev.
 */
export function getClientIp(request: Request): string {
  const vercel = request.headers.get('x-vercel-forwarded-for')?.trim();
  if (vercel) return vercel.split(',').pop()!.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return request.headers.get('x-real-ip')?.trim() || '127.0.0.1';
}

// Public write endpoints (feedback, NPS, dish reports) cost no AI money, so
// they get their own generous budget rather than the search budget. The point
// is not cost — it is that these are unauthenticated inserts, and flooding
// them pollutes the admin feedback inbox and the eval ground truth.
export const MAX_WRITES_PER_HOUR = parseInt(process.env.WRITE_MAX_PER_HOUR || '20', 10);

export type WriteKind = 'feedback' | 'nps' | 'report';

/**
 * Per-IP budget for a public write endpoint.
 *
 * Deliberately fails OPEN, unlike checkRateLimit: no money is at stake, and
 * silently swallowing a real user's bug report because a telemetry table is
 * unavailable is the worse failure. Losing feedback is worse than accepting junk.
 */
export async function checkWriteRateLimit(
  ip: string,
  kind: WriteKind
): Promise<{ allowed: boolean; remaining: number }> {
  const sb = getSupabase();
  if (!sb) return { allowed: true, remaining: MAX_WRITES_PER_HOUR };

  const ipHash = hashIp(ip);
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const result = await sb
      .from('write_rate_limit_events')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .eq('kind', kind)
      .gte('created_at', windowStart);
    if (result.error) return { allowed: true, remaining: MAX_WRITES_PER_HOUR };
    const count = result.count ?? 0;
    if (count >= MAX_WRITES_PER_HOUR) return { allowed: false, remaining: 0 };
    await sb.from('write_rate_limit_events').insert({ ip_hash: ipHash, kind });
    return { allowed: true, remaining: Math.max(0, MAX_WRITES_PER_HOUR - count - 1) };
  } catch {
    return { allowed: true, remaining: MAX_WRITES_PER_HOUR };
  }
}
