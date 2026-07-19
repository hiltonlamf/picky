import { notFound } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import {
  fetchRestaurantWithDishes,
  getMenuCandidates,
  getEvalCaseByUrl,
  getRestaurantFeedback,
  getMenuCandidateVerdicts,
  getGuideCities,
} from '@/lib/db';
import ReviewClient from './ReviewClient';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

export default async function RestaurantReviewPage({ params }: { params: { id: string } }) {
  const restaurant = await fetchRestaurantWithDishes(params.id, { includeDeleted: true });
  if (!restaurant) notFound();

  const discovery = await getMenuCandidates(params.id).catch(() => null);
  const candidates = discovery?.candidates ?? [];

  const evalCase = await getEvalCaseByUrl(restaurant.canonicalUrl ?? restaurant.url).catch(() => null);
  const feedback = await getRestaurantFeedback(params.id).catch(() => ({ dishReports: [], restaurantFeedback: [] }));
  const candidateVerdicts = await getMenuCandidateVerdicts(restaurant.canonicalUrl ?? restaurant.url).catch(() => ({}));
  const guideCities = await getGuideCities(params.id).catch(() => [] as string[]);

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav />
      <ReviewClient
        restaurant={restaurant}
        candidates={candidates}
        candidateVerdicts={candidateVerdicts}
        missedMenusInitial={evalCase?.missedMenus ?? ''}
        menusReviewedAtInitial={evalCase?.menusReviewedAt ?? null}
        dishReports={feedback.dishReports}
        restaurantFeedback={feedback.restaurantFeedback}
        inGuideInitial={guideCities.includes(restaurant.city)}
      />
    </div>
  );
}
