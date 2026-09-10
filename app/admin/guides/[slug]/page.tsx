import { notFound } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import { getCityGuideBySlug, getFeaturedRestaurants, listGuideQueue } from '@/lib/db';
import { isPubliclyVisible, heldBackReason, countDishes } from '@/lib/review-flags';
import { queueSummary, hasLiveRun } from '@/lib/guide-queue';
import GuideWorkspaceClient, { type WorkspaceRestaurant } from './GuideWorkspaceClient';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

export default async function GuideWorkspacePage({ params }: { params: { slug: string } }) {
  const guide = await getCityGuideBySlug(params.slug);
  if (!guide) notFound();

  const [restaurants, queueRows] = await Promise.all([
    getFeaturedRestaurants(guide.slug, { includeHidden: true }),
    // A second, LIGHT read purely for `updated_at`. It is what separates a row a
    // server run is analysing this minute from one an interrupted run abandoned
    // hours ago — the difference between "wait" and "run it again", and the
    // whole reason the founder sat waiting on work nothing was doing. Not worth
    // widening the Restaurant type and every mapper for one admin screen.
    listGuideQueue(guide.slug).catch(() => []),
  ]);

  const updatedById = new Map(queueRows.map((r) => [r.id, r.updatedAt]));

  const items: WorkspaceRestaurant[] = restaurants.map((r) => {
    const updatedAt = updatedById.get(r.id) ?? null;
    return {
      id: r.id,
      name: r.name ?? null,
      url: r.url,
      status: r.status,
      updatedAt,
      dishCount: countDishes(r),
      menuLanguage: r.menuLanguage ?? null,
      hidden: !!r.guideHidden,
      publiclyVisible: !r.guideHidden && isPubliclyVisible(r),
      heldBackReason: r.guideHidden ? null : heldBackReason(r, updatedAt),
    };
  });

  // Computed on the server from the same rows the worker reads, so the header
  // figures, the badges and what a run will actually do cannot disagree.
  const summary = queueSummary(queueRows);

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="guides" />
      <GuideWorkspaceClient
        guide={{ slug: guide.slug, displayName: guide.displayName, country: guide.country, status: guide.status }}
        restaurants={items}
        queue={{ ...summary, runLive: hasLiveRun(queueRows) }}
      />
    </div>
  );
}
