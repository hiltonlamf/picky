import { createHmac } from 'crypto';

const MAX_CITY_VOTE_BODY_BYTES = 4_096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CityVoteRequestRejection {
  status: 403 | 413 | 415;
  error: string;
}

/**
 * Keep the public write endpoint same-origin and JSON-only. Requiring JSON
 * prevents a cross-site HTML form from submitting a vote, while the Origin /
 * Sec-Fetch-Site checks reject cross-site fetches before their body is read.
 */
export function validateCityVoteRequest(request: Request): CityVoteRequestRejection | null {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { status: 415, error: 'This endpoint accepts JSON only.' };
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CITY_VOTE_BODY_BYTES) {
    return { status: 413, error: 'Request is too large.' };
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return { status: 403, error: 'Cross-site requests are not allowed.' };
  }

  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return { status: 403, error: 'Cross-site requests are not allowed.' };
  }

  return null;
}

/**
 * IPs have a tiny search space, so an ordinary salted hash is reversible.
 * HMAC makes the stored abuse-control key useless without a server secret.
 * A dedicated secret can be supplied, while the already-required service key
 * is a safe production fallback and never enters the browser bundle.
 */
export function hashCityVoteIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('IP hashing is not configured');
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/** Only middleware-issued UUIDs belong in operational records. */
export function validatedAnonId(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}
