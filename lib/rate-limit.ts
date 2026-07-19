import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

// `||` (not `??`) so an empty RATE_LIMIT_MAX_PER_HOUR ("") also falls back to
// the default instead of parsing to NaN. Exported so the user-facing error
// messages quote the real number instead of a hardcoded one.
export const MAX_SEARCHES_PER_HOUR = parseInt(process.env.RATE_LIMIT_MAX_PER_HOUR || '15', 10);

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

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip + 'picky-salt-2024').digest('hex').slice(0, 16);
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
  if (!sb) return { allowed: true, remaining: MAX_SEARCHES_PER_HOUR };

  const ipHash = hashIp(ip);
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  let requestCount = 0;
  try {
    const result = await sb
      .from('rate_limit_events')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', windowStart);
    requestCount = result.count ?? 0;
  } catch {
    requestCount = 0;
  }

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

export function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    '127.0.0.1'
  );
}
