import { notFound, permanentRedirect } from 'next/navigation';
import RestaurantPage from '@/components/RestaurantPage';
import { getRestaurantPublicPath } from '@/lib/db';
import { withShareAttribution } from '@/lib/restaurant-url';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Compatibility route for every UUID link already shared or indexed. It sends
 * visitors to the permanent readable URL while preserving share attribution.
 */
export default async function LegacyRestaurantPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.id)) {
    notFound();
  }

  const path = await getRestaurantPublicPath(params.id).catch(() => null);
  if (path) permanentRedirect(withShareAttribution(path, searchParams));

  // During the short code-before-migration window, keep serving the old page
  // instead of turning a database rollout detail into a user-visible outage.
  return <RestaurantPage restaurantId={params.id} />;
}
