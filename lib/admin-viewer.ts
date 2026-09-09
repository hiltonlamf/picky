import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, expectedAdminCookieValue } from './admin-auth';

/**
 * Whether the current viewer is a signed-in admin.
 *
 * Mirrors the middleware's cookie check and FAILS CLOSED — with no
 * ADMIN_PASSWORD configured, nobody is an admin. Server-only: it reads request
 * cookies, so any page calling it must be `force-dynamic`.
 *
 * Used to decide whether draft city guides are visible. Three public surfaces
 * ask the same question now (the guide page's preview mode, /guides, and the
 * city switcher), so it lives here rather than being copied into each — a
 * second, subtly different copy of an auth check is how one of them ends up
 * failing open.
 */
export async function isAdminViewer(): Promise<boolean> {
  const expected = await expectedAdminCookieValue();
  if (!expected) return false;
  return cookies().get(ADMIN_COOKIE_NAME)?.value === expected;
}
