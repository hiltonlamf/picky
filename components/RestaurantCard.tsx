import Link from 'next/link';
import type { Restaurant } from '@/types';
import FreshnessIndicator from './FreshnessIndicator';
import { guideInsights } from '@/lib/menu-insights';

interface Props {
  restaurant: Restaurant;
}

export default function RestaurantCard({ restaurant }: Props) {
  const { maxVegOptions, bestMenu, perMenu, highlights } = guideInsights(restaurant);

  // Per-menu breakdown only matters when there's more than one source menu.
  const namedMenus = perMenu.filter((m) => m.label);
  const showPerMenu = namedMenus.length > 1;

  return (
    <Link
      href={`/restaurant/${restaurant.id}`}
      className="card p-5 block hover:shadow-glow hover:border-picky-300 transition-all duration-200 group"
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="font-semibold text-evergreen group-hover:text-picky-700 transition-colors leading-tight">
          {restaurant.name ?? 'Restaurant'}
        </h3>
        <span className="flex-shrink-0 text-xs bg-mint-100 text-picky-700 font-medium px-2 py-1 rounded-full">
          {maxVegOptions} veg {maxVegOptions === 1 ? 'option' : 'options'}
        </span>
      </div>

      {restaurant.cuisine && (
        <p className="text-xs font-mono uppercase tracking-[0.08em] text-evergreen/50 mb-3">
          {restaurant.cuisine}
        </p>
      )}

      {/* Vegan / veggie split — from the BEST single menu (what a diner sees at
          one sitting), shown once each with the emojis. */}
      <div className="flex gap-3 mb-2">
        {bestMenu.vegan > 0 && (
          <span className="text-xs flex items-center gap-1 text-picky-700">
            <span aria-hidden="true">🌱</span>
            {bestMenu.vegan} vegan
          </span>
        )}
        {bestMenu.vegetarian > 0 && (
          <span className="text-xs flex items-center gap-1 text-picky-600">
            <span aria-hidden="true">🥚</span>
            {bestMenu.vegetarian} veggie
          </span>
        )}
      </div>

      {/* Per-menu breakdown — a diner sees one menu per visit, so show each. */}
      {showPerMenu && (
        <p className="text-xs text-evergreen/70 mb-2">
          {namedMenus.map((m, i) => (
            <span key={m.label}>
              {i > 0 && <span className="text-evergreen/30"> · </span>}
              {m.label} <span className="font-semibold text-evergreen/80">{m.vegOptions}</span>
            </span>
          ))}
        </p>
      )}

      {/* A few standout veg dishes (the priciest ≈ the mains). */}
      {highlights.length > 0 && (
        <p className="text-xs text-evergreen/80 mb-3">
          <span className="font-medium text-evergreen">Highlights:</span> {highlights.join(', ')}
        </p>
      )}

      <FreshnessIndicator lastScrapedAt={restaurant.lastScrapedAt} restaurantId={restaurant.id} />

      <div className="mt-3 text-xs text-picky-600 font-medium group-hover:underline">
        View full menu →
      </div>
    </Link>
  );
}
