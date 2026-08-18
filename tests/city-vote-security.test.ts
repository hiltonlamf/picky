import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { hashCityVoteIp, validateCityVoteRequest, validatedAnonId } from '@/lib/city-vote-security';

const ORIGINAL_IP_HASH_SECRET = process.env.IP_HASH_SECRET;
const ORIGINAL_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

afterEach(() => {
  if (ORIGINAL_IP_HASH_SECRET === undefined) delete process.env.IP_HASH_SECRET;
  else process.env.IP_HASH_SECRET = ORIGINAL_IP_HASH_SECRET;
  if (ORIGINAL_SERVICE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SERVICE_KEY;
});

describe('city vote request security', () => {
  function request(headers: Record<string, string> = {}) {
    return new Request('https://picky.example/api/city-votes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    });
  }

  it('accepts same-origin JSON requests', () => {
    expect(validateCityVoteRequest(request({ origin: 'https://picky.example' }))).toBeNull();
  });

  it('rejects cross-site and form-compatible submissions', () => {
    expect(validateCityVoteRequest(request({ origin: 'https://evil.example' }))?.status).toBe(403);
    expect(validateCityVoteRequest(request({ 'sec-fetch-site': 'cross-site' }))?.status).toBe(403);
    expect(validateCityVoteRequest(request({ 'content-type': 'text/plain' }))?.status).toBe(415);
  });

  it('rejects declared oversized bodies', () => {
    expect(validateCityVoteRequest(request({ 'content-length': '4097' }))?.status).toBe(413);
  });
});

describe('city vote identifiers', () => {
  it('uses a secret HMAC rather than the old public-salt hash', () => {
    process.env.IP_HASH_SECRET = 'test-only-secret';
    const hashed = hashCityVoteIp('203.0.113.8');
    const publicHash = createHash('sha256').update('203.0.113.8picky-salt-2024').digest('hex');
    expect(hashed).toHaveLength(64);
    expect(hashed).not.toBe(publicHash);
    expect(hashCityVoteIp('203.0.113.8')).toBe(hashed);
  });

  it('fails closed without server-side key material', () => {
    delete process.env.IP_HASH_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => hashCityVoteIp('203.0.113.8')).toThrow('IP hashing is not configured');
  });

  it('keeps only middleware-shaped anonymous IDs', () => {
    expect(validatedAnonId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(validatedAnonId('attacker-controlled')).toBeNull();
    expect(validatedAnonId(null)).toBeNull();
  });
});
