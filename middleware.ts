import { NextRequest, NextResponse } from 'next/server';
import { ANON_ID_COOKIE } from './lib/telemetry';

/**
 * Sets the anonymous usage ID cookie on first visit (disclosed in the
 * cookie-consent banner). One random UUID per browser, 1-year expiry —
 * the basis for usage-per-person measurement and later monetization.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
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
  // Pages and API routes only — skip static assets and files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
