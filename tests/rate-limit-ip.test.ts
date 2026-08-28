import { describe, it, expect } from 'vitest';
import { getClientIp } from '@/lib/rate-limit';

function req(headers: Record<string, string>): Request {
  return new Request('https://platefully.vercel.app/api/parse/discover', { headers });
}

describe('getClientIp', () => {
  // The bug this guards: reading x-forwarded-for[0] let anyone mint a fresh
  // rate-limit bucket per request, bypassing both the AI-spend cap and the
  // admin-login brute-force throttle.
  it('ignores a spoofed leftmost x-forwarded-for entry', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('pins every spoofed prefix to the same real client IP', () => {
    const a = getClientIp(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }));
    const b = getClientIp(req({ 'x-forwarded-for': '8.8.8.8, 203.0.113.9' }));
    const c = getClientIp(req({ 'x-forwarded-for': '203.0.113.9' }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('prefers x-vercel-forwarded-for, which a client cannot forge', () => {
    const ip = getClientIp(
      req({ 'x-forwarded-for': '1.2.3.4', 'x-vercel-forwarded-for': '203.0.113.7' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to localhost', () => {
    expect(getClientIp(req({ 'x-real-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(getClientIp(req({}))).toBe('127.0.0.1');
  });

  it('tolerates whitespace and empty hops', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4 , , 203.0.113.9 ' }))).toBe('203.0.113.9');
  });
});
