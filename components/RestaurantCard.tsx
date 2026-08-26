'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Restaurant } from '@/types';
import { guideInsights } from '@/lib/menu-insights';
import { restaurantPath } from '@/lib/restaurant-url';
import FeedbackModal from './FeedbackModal';
import { FlagIcon } from './icons';

interface Props {
  restaurant: Restaurant;
  city?: string;
}

export default function RestaurantCard({ restaurant, city }: Props) {
  const { maxVegOptions, asideCount, bestMenu, perMenu, highlights, highlightsAreThin } =
    guideInsights(restaurant);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Per-menu breakdown only matters when there's more than one source menu.
  const namedMenus = perMenu.filter((m) => m.label);
  const showPerMenu = namedMenus.length > 1;
  const menuLabels = namedMenus.map((m) => m.label as string);
  const branchAreas = Array.from(new Set((restaurant.locations ?? [])
    .map((location) => location.area ?? location.neighbourhood ?? location.areaCode)
    .filter((value): value is string => !!value)));
  const displayedAreas = branchAreas.length
    ? branchAreas
    : [restaurant.area ?? restaurant.neighbourhood ?? restaurant.areaCode]
      .filter((value): value is string => !!value);

  return (
    <div
      className="group relative overflow-hidden bg-white border-2 border-forest rounded-[20px] p-5 flex flex-col gap-2.5
                 transition-all duration-200 hover:-translate-y-[3px] hover:border-azalea-500 hover:shadow-card-pop"
    >
      {/* Covers the whole card so it stays clickable; the visible content
          below is wrapped in a `pointer-events-none` block so hovering or
          clicking directly over any of the text (headings, highlights,
          "View full menu") passes through to this overlay instead of being
          swallowed by the text elements themselves. The flag button is a
          real sibling outside that block, so it keeps its own clicks and
          never triggers navigation. */}
      <Link
        href={restaurantPath(restaurant, city)}
        className="absolute inset-0"
        aria-label={`View menu for ${restaurant.name ?? 'this restaurant'}`}
      />

      {/* A breath of the mesh field, so the card belongs to the same world. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-12 w-32 h-32 rounded-full blur-[14px]
                   bg-[radial-gradient(circle,rgba(255,45,143,0.22),transparent_68%)]"
      />

      <div className="relative flex flex-col gap-2.5 pointer-events-none">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg leading-tight tracking-[-0.02em] text-forest">
            {restaurant.name ?? 'Restaurant'}
          </h3>
          {restaurant.cuisine && (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-forest border-[1.5px] border-forest rounded-full px-2.5 py-1">
              {restaurant.cuisine}
            </span>
          )}
        </div>
        {displayedAreas.length > 0 && (
          <p className="-mt-1 text-xs text-forest/65">{displayedAreas.join(' · ')}</p>
        )}

        {/* Dietary counts stay green with their emoji — pink never carries
            dietary meaning. The capsule is glass, the numbers are not.
            The count is dishes you would order AS a dish; desserts, sauces and
            plain breads are tallied beside it rather than folded in, so the
            headline can't be inflated by a €3 pot of tahini. */}
        <div className="glass-light self-start inline-flex items-center gap-3 rounded-full px-3.5 py-2 text-sm font-semibold">
          {bestMenu.vegan > 0 && (
            <span className="text-picky-700 whitespace-nowrap">
              <span aria-hidden="true">🌱</span> {bestMenu.vegan} vegan
            </span>
          )}
          {maxVegOptions > 0 ? (
            <span className="text-picky-600 whitespace-nowrap">
              <span aria-hidden="true">🍳</span> {maxVegOptions} veggie
            </span>
          ) : (
            // An honest empty state beats a bare "0 veggie" next to a green
            // badge — this restaurant has sides and sweets but no veggie dish.
            <span className="text-forest/70 whitespace-nowrap">
              <span aria-hidden="true">😢</span> No veggie mains
            </span>
          )}
        </div>

        {asideCount > 0 && (
          <p className="text-xs text-forest/60 -mt-1">
            plus {asideCount} side{asideCount === 1 ? '' : 's'}, sauce
            {asideCount === 1 ? '' : 's'} &amp; sweet{asideCount === 1 ? '' : 's'} we don&rsquo;t count
          </p>
        )}

        {/* A diner sees one menu per visit, so show each. */}
        {showPerMenu && (
          <p className="text-xs text-forest/70">
            {namedMenus.map((m, i) => (
              <span key={m.label}>
                {i > 0 && <span className="text-forest/30"> · </span>}
                {m.label} <span className="font-semibold text-forest/85">{m.vegOptions}</span>
              </span>
            ))}
          </p>
        )}

        {highlights.length > 0 && (
          <div className="text-[0.82rem] leading-relaxed text-forest/80">
            <p className="font-semibold text-forest">Highlights:</p>
            <ul className="mt-0.5 space-y-0.5">
              {highlights.map((h, i) => (
                <li key={i}>
                  {h.name}
                  {h.price && <span className="text-forest/60"> · {h.price}</span>}
                </li>
              ))}
            </ul>
            {highlightsAreThin && (
              <p className="mt-1 text-forest/60 italic">
                😢 That&rsquo;s everything veggie we found here.
              </p>
            )}
          </div>
        )}

        <p className="font-display text-[0.85rem] text-azalea-700 mt-0.5">View full menu →</p>
      </div>

      <button
        type="button"
        onClick={() => setFeedbackOpen(true)}
        className="absolute bottom-3 right-3 p-1.5 rounded-full text-forest/50 hover:text-forest hover:bg-mint-100 transition-colors"
        aria-label={`Report an issue with ${restaurant.name ?? 'this restaurant'}`}
        title="Report an issue"
      >
        <FlagIcon className="w-3.5 h-3.5" />
      </button>

      {feedbackOpen && (
        <FeedbackModal
          restaurantId={restaurant.id}
          restaurantName={restaurant.name ?? null}
          menuLabels={menuLabels}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </div>
  );
}
