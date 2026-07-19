import { NextRequest, NextResponse } from 'next/server';
import { ANON_ID_COOKIE } from './lib/telemetry';
import { ADMIN_COOKIE_NAME, expectedAdminCookieValue } from './lib/admin-auth';

const ADMIN_PUBLIC_PATHS = new Set(['/admin/login', '/api/admin/login', '/api/admin/logout']);

function isAdminGatedPath(pathname: string): boolean {
  return (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) && !ADMIN_PUBLIC_PATHS.has(pathname);
}

/**
 * Two independent jobs share this one file because Next.js only runs a
 * single middleware:
 *  1. Anonymous usage ID — one random UUID per browser, 1-year cookie, set
 *     on first visit (disclosed in the cookie-consent banner) for every page
 *     and API route.
 *  2. Admin gate — every /admin page and /api/admin route requires the
 *     ADMIN_PASSWORD cookie. Fails closed: if ADMIN_PASSWORD isn't
 *     configured, no cookie value can ever match, so /admin stays
 *     unreachable rather than accidentally open.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response: NextResponse;
  if (isAdminGatedPath(pathname)) {
    const expected = await expectedAdminCookieValue();
    const cookie = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (!expected || cookie !== expected) {
      response = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        : NextResponse.redirect(new URL('/admin/login', request.url));
    } else {
      response = NextResponse.next();
    }
  } else {
    response = NextResponse.next();
  }

  if (!request.cookies.get(ANON_ID_COOKIE)) {
    response.cookies.set(ANON_ID_COOKIE, crypto.randomUUID(), {
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
    });
  }
  return response;
}

export const config = {
  // Pages and API routes only — skip static assets and files. Already
  // covers /admin and /api/admin, so one matcher serves both jobs above.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
