/**
 * Shared admin-auth helpers used by both `middleware.ts` (Edge runtime) and
 * `app/api/admin/login/route.ts` (Node runtime). Uses only Web Crypto
 * (`crypto.subtle`), which is available as a global in both runtimes — so
 * there's one implementation instead of an Edge-only and a Node-only copy
 * that could quietly drift out of sync.
 *
 * The httpOnly cookie stores a SHA-256 hash of ADMIN_PASSWORD, not the
 * password itself, so the plaintext never sits in the browser or in request
 * logs — middleware just compares hashes.
 */

export const ADMIN_COOKIE_NAME = 'picky_admin';

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Null when ADMIN_PASSWORD isn't configured — callers must fail closed (deny), not open. */
export async function expectedAdminCookieValue(): Promise<string | null> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  return sha256Hex(password);
}
