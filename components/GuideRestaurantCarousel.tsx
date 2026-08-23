'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import RestaurantCard from './RestaurantCard';
import { ChevronIcon } from './icons';
import type { Restaurant } from '@/types';

export default function GuideRestaurantCarousel({ restaurants }: { restaurants: Restaurant[] }) {
  const railRef = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(restaurants.length <= 1);

  const updateEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    // The rail's negative outer margin means its resting scroll position can
    // begin at the 24px inner gutter instead of literal zero in Chromium.
    setAtStart(rail.scrollLeft <= 32);
    setAtEnd(rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 32);
  }, []);

  useEffect(() => {
    updateEdges();
    window.addEventListener('resize', updateEdges);
    return () => window.removeEventListener('resize', updateEdges);
  }, [updateEdges]);

  const move = (direction: -1 | 1) => {
    const rail = railRef.current;
    const firstCard = rail?.firstElementChild as HTMLElement | null;
    if (!rail || !firstCard) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollBy({
      left: direction * (firstCard.offsetWidth + 16),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <div
      className="mt-8"
      role="region"
      aria-label="Popular Dublin restaurants"
      aria-roledescription="carousel"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-forest/65">
          A taste of the guide · swipe for more
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={atStart}
            aria-label="Show previous restaurants"
            className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-forest text-forest transition-all hover:-translate-y-0.5 hover:bg-forest hover:text-paper disabled:cursor-default disabled:border-forest/20 disabled:text-forest/25 disabled:hover:translate-y-0 disabled:hover:bg-transparent"
          >
            <ChevronIcon direction="left" className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={atEnd}
            aria-label="Show more restaurants"
            className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-forest bg-forest text-paper transition-all hover:-translate-y-0.5 hover:border-azalea-500 hover:bg-azalea-500 disabled:cursor-default disabled:border-forest/20 disabled:bg-transparent disabled:text-forest/25 disabled:hover:translate-y-0"
          >
            <ChevronIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="relative">
        <ul
          ref={railRef}
          onScroll={updateEdges}
          className="-mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {restaurants.map((restaurant) => (
            <li
              key={restaurant.id}
              className="flex h-auto shrink-0 basis-[86%] snap-start sm:basis-[56%] lg:basis-[42%] [&>*]:w-full"
            >
              <RestaurantCard restaurant={restaurant} />
            </li>
          ))}
        </ul>

        {!atEnd && (
          <div
            className="pointer-events-none absolute inset-y-0 -right-6 w-16 bg-gradient-to-l from-paper to-transparent"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
