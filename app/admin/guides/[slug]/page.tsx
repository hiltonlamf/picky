import { notFound } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import { getCityGuideBySlug, getFeaturedRestaurants } from '@/lib/db';
import { isPubliclyVisible, heldBackReason, countDishes } from '@/lib/review-flags';
import type { Restaurant } from '@/types';
import GuideWorkspaceClient, { type WorkspaceRestaurant } from './GuideWorkspaceClient';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

export default async function GuideWorkspacePage({ params }: { params: { slug: string } }) {
  const guide = await getCityGuideBySlug(params.slug);
  if (!guide) notFound();

  const restaurants = await getFeaturedRestaurants(guide.slug, { includeHidden: true });

  const items: WorkspaceRestaurant[] = restaurants.map((r) => ({
    id: r.id,
    name: r.name ?? null,
    url: r.url,
    status: r.status,
    dishCount: countDishes(r),
    menuLanguage: r.menuLanguage ?? null,
    hidden: !!r.guideHidden,
    publiclyVisible: !r.guideHidden && isPubliclyVisible(r),
    heldBackReason: r.guideHidden ? null : heldBackReason(r),
  }));

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="guides" />
      <GuideWorkspaceClient
        guide={{ slug: guide.slug, displayName: guide.displayName, country: guide.country, status: guide.status }}
        restaurants={items}
      />
    </div>
  );
}
