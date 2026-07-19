import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { hashIp, getClientIp } from '@/lib/rate-limit';
import { ADMIN_COOKIE_NAME, sha256Hex } from '@/lib/admin-auth';

const schema = z.object({ password: z.string().min(1).max(200) });

// A separate, tighter budget than the public search rate limit (lib/rate-limit.ts,
// 5/hr) — reuses the same rate_limit_events table but with a namespaced
// ip_hash so brute-forcing the admin password can't share (or exhaust) the
// public search counter, and vice versa.
const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 8;
const WINDOW_MS = 15 * 60 * 1000;

async function checkLoginRateLimit(ip: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return true; // no DB configured locally — nothing to rate-limit against

  const sb = createClient(url, key);
  const ipHash = hashIp(`admin-login:${ip}`);
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  try {
    const { count } = await sb
      .from('rate_limit_events')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', windowStart);
    if ((count ?? 0) >= MAX_LOGIN_ATTEMPTS_PER_WINDOW) return false;
    await sb.from('rate_limit_events').insert({ ip_hash: ipHash });
    return true;
  } catch {
    return true; // rate-limit bookkeeping failing must never lock out a real login
  }
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const allowed = await checkLoginRateLimit(ip);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts — please wait a while and try again.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ error: 'Admin login is not configured on this server.' }, { status: 500 });
  }
  if (parsed.data.password !== adminPassword) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const hash = await sha256Hex(adminPassword);
  const res = NextResponse.json({ success: true });
  res.cookies.set(ADMIN_COOKIE_NAME, hash, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 1 week
  });
  return res;
}
