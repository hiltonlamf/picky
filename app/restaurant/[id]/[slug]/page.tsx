import { notFound, redirect } from 'next/navigation';
import RestaurantPage from '@/components/RestaurantPage';
import { getCityGuideBySlug, getRestaurantByPublicPath } from '@/lib/db';
import { withShareAttribution } from '@/lib/restaurant-url';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default async function ReadableRestaurantPage({
  params,
  searchParams,
}: {
  // The first segment shares Next's existing [id] folder with the legacy UUID
  // page; in this two-segment route that value is the public city.
  params: { id: string; slug: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const city = params.id;
  const restaurant = await getRestaurantByPublicPath(city, params.slug).catch(() => null);
  if (!restaurant) notFound();

  const requestedPath = `/restaurant/${city}/${params.slug}`;
  if (restaurant.path !== requestedPath) {
    redirect(withShareAttribution(restaurant.path, searchParams));
  }

  // Only a PUBLISHED guide earns a "back to" link — pointing at a draft would
  // 404 for everyone but an admin.
  const guide = await getCityGuideBySlug(city).catch(() => null);
  const backGuide =
    guide?.status === 'published' ? { slug: guide.slug, displayName: guide.displayName } : null;

  return <RestaurantPage restaurantId={restaurant.id} backGuide={backGuide} />;
}
