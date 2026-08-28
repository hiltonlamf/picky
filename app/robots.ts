import type { MetadataRoute } from 'next';

const base = process.env.NEXT_PUBLIC_APP_URL || 'https://platefully.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Admin is already password-gated; keeping it out of the index means it
      // never shows up in a search result to be probed in the first place.
      disallow: ['/admin', '/api/'],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
