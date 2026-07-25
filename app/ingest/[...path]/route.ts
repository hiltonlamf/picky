import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Analytics proxy for PostHog.
 *
 * Why this is a route handler and not a next.config.js rewrite: a rewrite proxies
 * the request with its headers copied verbatim, and because /ingest is
 * same-origin the browser attaches every cookie scoped to the site — including
 * the admin session cookie, which is set with Path=/ and is a static, non-rotating
 * bearer token. That meant a logged-in admin browsing the *public* site sent their
 * admin credential to a third party on every analytics beacon. httpOnly does not
 * help: it stops JavaScript reading the cookie, not the browser attaching it.
 *
 * So the request is rebuilt here with an explicit allowlist instead. PostHog needs
 * no first-party cookies — posthog-js carries identity in the payload — so
 * dropping them costs nothing and closes the leak for every current and future
 * cookie, rather than just the one we happen to know about.
 *
 * The proxy still exists for the original reason: requests to posthog.com are
 * blocked by most ad blockers, which silently drops a fifth to a third of events
 * and skews what survives toward less technical users.
 */

const EVENTS_HOST = 'https://eu.i.posthog.com';
const ASSETS_HOST = 'https://eu-assets.i.posthog.com';

/**
 * Headers we pass upstream. An allowlist, not a blocklist: a blocklist silently
 * fails open the next time a new sensitive header appears.
 *
 * Deliberately absent: `cookie` (the whole point), `authorization`, and `host`.
 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'content-encoding', 'user-agent', 'accept'];

/**
 * Headers we pass back. Notably NOT set-cookie: an analytics vendor has no
 * business writing cookies on our first-party domain.
 *
 * Also NOT content-encoding, and correspondingly `accept-encoding` is not sent
 * upstream: Node's fetch transparently decompresses the response, so echoing
 * `content-encoding: gzip` alongside an already-decompressed body would make the
 * browser try to gunzip plain bytes and fail. Compression on the way back to the
 * browser is the platform's job.
 */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control'];

function upstreamUrl(request: NextRequest, path: string[]): string {
  // /ingest/static/* serves the SDK bundle from PostHog's asset host; everything
  // else is event ingestion.
  const isStatic = path[0] === 'static';
  const base = isStatic ? ASSETS_HOST : EVENTS_HOST;
  const search = request.nextUrl.search;
  return `${base}/${path.join('/')}${search}`;
}

function pickHeaders(source: Headers, allow: string[]): Headers {
  const out = new Headers();
  for (const name of allow) {
    const value = source.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

async function proxy(request: NextRequest, path: string[], body?: BodyInit | null): Promise<NextResponse> {
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(request, path), {
      method: request.method,
      headers: pickHeaders(request.headers, FORWARD_REQUEST_HEADERS),
      body,
      // Never send our cookies, and never accept theirs.
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch {
    // Analytics must never break the page it rides on. A dropped beacon is a
    // missing datapoint; a thrown error here would surface to the user.
    return new NextResponse(null, { status: 204 });
  }

  const headers = pickHeaders(upstream.headers, FORWARD_RESPONSE_HEADERS);
  // The SDK bundle is immutable per version — let the CDN serve it so this
  // function isn't invoked for every page load.
  if (path[0] === 'static') headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params.path);
}

export async function POST(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params.path, await request.arrayBuffer());
}

/** posthog-js preflights some ingest endpoints. */
export async function OPTIONS(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params.path);
}
