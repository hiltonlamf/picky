import type { MetadataRoute } from 'next';
import { getPublishedGuideSlugs } from '@/lib/db';

// Reads the database, so it must not be prerendered: CI builds have no
// Supabase credentials and a build-time DB call would fail the build.
export const dynamic = 'force-dynamic';

const base = process.env.NEXT_PUBLIC_APP_URL || 'https://platefully.vercel.app';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/vote`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal`, changeFrequency: 'yearly', priority: 0.2 },
  ];

  // A sitemap is a nice-to-have; never let a database blip 500 the route.
  try {
    const guides = await getPublishedGuideSlugs();
    return [
      ...staticRoutes,
      ...guides.map((g) => ({
        url: `${base}/${g.slug}`,
        lastModified: g.publishedAt ? new Date(g.publishedAt) : undefined,
        changeFrequency: 'weekly' as const,
        priority: 0.9,
      })),
    ];
  } catch {
    return staticRoutes;
  }
}
