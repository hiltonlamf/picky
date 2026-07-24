import Link from 'next/link';
import type { Restaurant } from '@/types';
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
      className="group relative overflow-hidden bg-white border-2 border-forest rounded-[20px] p-5 flex flex-col gap-2.5
                 transition-all duration-200 hover:-translate-y-[3px] hover:border-azalea-500 hover:shadow-card-pop"
    >
      {/* A breath of the mesh field, so the card belongs to the same world. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-12 w-32 h-32 rounded-full blur-[14px]
                   bg-[radial-gradient(circle,rgba(255,45,143,0.22),transparent_68%)]"
      />

      <div className="relative flex items-start justify-between gap-3">
        <h3 className="font-display text-lg leading-tight tracking-[-0.02em] text-forest">
          {restaurant.name ?? 'Restaurant'}
        </h3>
        {restaurant.cuisine && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-forest border-[1.5px] border-forest rounded-full px-2.5 py-1">
            {restaurant.cuisine}
          </span>
        )}
      </div>

      {/* Dietary counts stay green with their emoji — pink never carries
          dietary meaning. The capsule is glass, the numbers are not. */}
      <div className="glass-light relative self-start inline-flex items-center gap-3 rounded-full px-3.5 py-2 text-sm font-semibold">
        {bestMenu.vegan > 0 && (
          <span className="text-picky-700 whitespace-nowrap">
            <span aria-hidden="true">🌱</span> {bestMenu.vegan} vegan
          </span>
        )}
        <span className="text-picky-600 whitespace-nowrap">
          <span aria-hidden="true">🍳</span> {maxVegOptions} veggie
        </span>
      </div>

      {/* A diner sees one menu per visit, so show each. */}
      {showPerMenu && (
        <p className="relative text-xs text-forest/70">
          {namedMenus.map((m, i) => (
            <span key={m.label}>
              {i > 0 && <span className="text-forest/30"> · </span>}
              {m.label} <span className="font-semibold text-forest/85">{m.vegOptions}</span>
            </span>
          ))}
        </p>
      )}

      {highlights.length > 0 && (
        <p className="relative text-[0.82rem] leading-relaxed text-forest/80">
          <span className="font-semibold text-forest">Highlights:</span> {highlights.join(' · ')}
        </p>
      )}

      <p className="relative font-display text-[0.85rem] text-azalea-700 mt-0.5">View full menu →</p>
    </Link>
  );
}
