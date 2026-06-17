import Link from 'next/link';
import type { Restaurant } from '@/types';
import FreshnessIndicator from './FreshnessIndicator';

interface Props {
  restaurant: Restaurant;
}

function countByClassification(restaurant: Restaurant, classification: string) {
  return restaurant.sections
    .flatMap((s) => s.dishes)
    .filter((d) => d.classification === classification).length;
}

export default function RestaurantCard({ restaurant }: Props) {
  const veganCount = countByClassification(restaurant, 'vegan');
  const vegetarianCount = countByClassification(restaurant, 'vegetarian');
  const totalVeg = veganCount + vegetarianCount;

  return (
    <Link
      href={`/restaurant/${restaurant.id}`}
      className="card p-5 block hover:shadow-md hover:border-picky-200 transition-all duration-200 group"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-semibold text-gray-900 group-hover:text-picky-700 transition-colors leading-tight">
          {restaurant.name ?? 'Restaurant'}
        </h3>
        <span className="flex-shrink-0 text-xs bg-picky-50 text-picky-700 font-medium px-2 py-1 rounded-full">
          {totalVeg} veg options
        </span>
      </div>

      <div className="flex gap-3 mb-3">
        {veganCount > 0 && (
          <span className="text-xs flex items-center gap-1 text-picky-700">
            <span>🥦</span>
            {veganCount} vegan
          </span>
        )}
        {vegetarianCount > 0 && (
          <span className="text-xs flex items-center gap-1 text-picky-600">
            <span>🍳</span>
            {vegetarianCount} vegetarian
          </span>
        )}
      </div>

      <FreshnessIndicator
        lastScrapedAt={restaurant.lastScrapedAt}
        restaurantId={restaurant.id}
      />

      <div className="mt-3 text-xs text-picky-600 font-medium group-hover:underline">
        View full menu →
      </div>
    </Link>
  );
}
