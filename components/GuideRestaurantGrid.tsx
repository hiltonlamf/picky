'use client';

import { useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Restaurant } from '@/types';
import { EVENTS } from '@/lib/analytics';
import { capture } from '@/lib/posthog-client';
import RestaurantCard from './RestaurantCard';

function updateUrl(pathname: string, current: URLSearchParams, key: string, value: string) {
  const next = new URLSearchParams(current.toString());
  if (value) next.set(key, value);
  else next.delete(key);
  return next.toString() ? `${pathname}?${next}` : pathname;
}

export default function GuideRestaurantGrid({ restaurants }: { restaurants: Restaurant[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const neighbourhood = searchParams.get('neighbourhood') ?? '';
  const cuisine = searchParams.get('cuisine') ?? '';
  const neighbourhoods = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.neighbourhood).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.cuisine).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const filtered = restaurants.filter(
    (r) => (!neighbourhood || r.neighbourhood === neighbourhood) && (!cuisine || r.cuisine === cuisine)
  );
  const select = (key: 'neighbourhood' | 'cuisine', value: string) => {
    capture(EVENTS.GUIDE_FILTER_CHANGED, { filter: key, value: value || null, city: pathname.split('/')[1] ?? null });
    router.replace(updateUrl(pathname, searchParams, key, value), { scroll: false });
  };
  const clearFilters = () => {
    capture(EVENTS.GUIDE_FILTER_CHANGED, { filter: 'all', value: null, city: pathname.split('/')[1] ?? null });
    router.replace(pathname, { scroll: false });
  };

  return (
    <section aria-label="Restaurant filters" className="mb-6">
      {(neighbourhoods.length > 0 || cuisines.length > 0) && (
        <div className="card p-4 mb-5 flex flex-col sm:flex-row sm:items-end gap-3">
          {neighbourhoods.length > 0 && (
            <label className="text-xs font-mono uppercase tracking-[0.08em] text-forest/70 flex-1">
              Neighbourhood
              <select value={neighbourhood} onChange={(e) => select('neighbourhood', e.target.value)} className="mt-1.5 block w-full rounded-lg border border-forest/30 bg-white px-3 py-2 normal-case tracking-normal text-sm text-forest">
                <option value="">All neighbourhoods</option>
                {neighbourhoods.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          {cuisines.length > 0 && (
            <label className="text-xs font-mono uppercase tracking-[0.08em] text-forest/70 flex-1">
              Cuisine
              <select value={cuisine} onChange={(e) => select('cuisine', e.target.value)} className="mt-1.5 block w-full rounded-lg border border-forest/30 bg-white px-3 py-2 normal-case tracking-normal text-sm text-forest">
                <option value="">All cuisines</option>
                {cuisines.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          {(neighbourhood || cuisine) && <button onClick={clearFilters} className="text-sm text-picky-700 underline whitespace-nowrap">Clear filters</button>}
        </div>
      )}
      {filtered.length > 0 ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {filtered.map((r) => <RestaurantCard key={r.id} restaurant={r} />)}
        </div>
      ) : <div className="card p-6 text-center text-evergreen/70">No restaurants match those filters.</div>}
    </section>
  );
}
