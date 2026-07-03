import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const MAX_PER_HOUR = parseInt(process.env.RATE_LIMIT_MAX_PER_HOUR ?? '5', 10);

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

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const sb = getSupabase();
  if (!sb) return { allowed: true, remaining: MAX_PER_HOUR };

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

  const allowed = requestCount < MAX_PER_HOUR;
  const remaining = Math.max(0, MAX_PER_HOUR - requestCount);

  if (allowed) {
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
