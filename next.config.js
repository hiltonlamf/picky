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
  // PostHog's own domains are on every ad-blocker list, which silently drops a
  // fifth to a third of analytics events — and disproportionately from more
  // technical users, so the data is skewed, not just thinner. Serving the
  // ingest endpoint from our own origin avoids that. Nothing is sent that
  // wasn't already being sent; only the hostname changes.
  async rewrites() {
    return [
      { source: '/ingest/static/:path*', destination: 'https://eu-assets.i.posthog.com/static/:path*' },
      { source: '/ingest/:path*', destination: 'https://eu.i.posthog.com/:path*' },
    ];
  },
  // PostHog's ingest paths are sensitive to a trailing-slash redirect landing
  // in the middle of a POST — required by their proxy setup.
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
