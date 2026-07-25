const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['cheerio'],
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
  // The PostHog proxy deliberately does NOT live here as a rewrite. A rewrite
  // forwards the request headers verbatim, and because /ingest is same-origin
  // the browser attaches every cookie scoped to the site — including the admin
  // session cookie (Path=/, a static non-rotating token). That sent an admin
  // credential to a third party on every beacon. It is now a route handler at
  // app/ingest/[...path]/route.ts that rebuilds the request with an explicit
  // header allowlist and no cookies.
  //
  // PostHog's ingest paths are sensitive to a trailing-slash redirect landing in
  // the middle of a POST.
  skipTrailingSlashRedirect: true,
};

// Source-map upload only happens when SENTRY_AUTH_TOKEN is set (CI/Vercel);
// local builds without it still succeed, just without readable stack traces.
module.exports = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
});
