import { notFound, redirect } from 'next/navigation';
import RestaurantPage from '@/components/RestaurantPage';
import { getRestaurantByPublicPath } from '@/lib/db';
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

  return <RestaurantPage restaurantId={restaurant.id} />;
}
