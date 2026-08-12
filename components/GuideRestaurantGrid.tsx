'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Restaurant } from '@/types';
import { EVENTS } from '@/lib/analytics';
import { capture } from '@/lib/posthog-client';
import RestaurantCard from './RestaurantCard';

function selectedValues(current: URLSearchParams, key: string): string[] {
  return (current.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function updateUrl(pathname: string, current: URLSearchParams, neighbourhoods: string[], cuisines: string[]) {
  const next = new URLSearchParams(current.toString());
  if (neighbourhoods.length) next.set('neighbourhood', neighbourhoods.join(','));
  else next.delete('neighbourhood');
  if (cuisines.length) next.set('cuisine', cuisines.join(','));
  else next.delete('cuisine');
  return next.toString() ? `${pathname}?${next}` : pathname;
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function GuideRestaurantGrid({ restaurants }: { restaurants: Restaurant[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedNeighbourhoods = selectedValues(searchParams, 'neighbourhood');
  const selectedCuisines = selectedValues(searchParams, 'cuisine');
  const [draftNeighbourhoods, setDraftNeighbourhoods] = useState(selectedNeighbourhoods);
  const [draftCuisines, setDraftCuisines] = useState(selectedCuisines);
  const neighbourhoods = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.neighbourhood).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.cuisine).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const filtered = restaurants.filter(
    (r) =>
      (!selectedNeighbourhoods.length || (!!r.neighbourhood && selectedNeighbourhoods.includes(r.neighbourhood))) &&
      (!selectedCuisines.length || (!!r.cuisine && selectedCuisines.includes(r.cuisine)))
  );
  const filtersChanged =
    draftNeighbourhoods.join('|') !== selectedNeighbourhoods.join('|') ||
    draftCuisines.join('|') !== selectedCuisines.join('|');
  useEffect(() => {
    setDraftNeighbourhoods(selectedNeighbourhoods);
    setDraftCuisines(selectedCuisines);
    // URL is the shareable source of truth after navigation/back/forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const applyFilters = () => {
    capture(EVENTS.GUIDE_FILTER_CHANGED, {
      city: pathname.split('/')[1] ?? null,
      neighbourhood_count: draftNeighbourhoods.length,
      cuisine_count: draftCuisines.length,
    });
    router.replace(updateUrl(pathname, searchParams, draftNeighbourhoods, draftCuisines), { scroll: false });
  };

  return (
    <section aria-label="Restaurant filters" className="mb-6">
      {(neighbourhoods.length > 0 || cuisines.length > 0) && (
        <div className="card p-4 mb-5">
          <p className="text-sm text-forest/75 mb-4">Choose one or more neighbourhoods and cuisines, then apply your filters.</p>
          <div className="grid sm:grid-cols-2 gap-5">
          {neighbourhoods.length > 0 && (
            <fieldset>
              <legend className="text-xs font-mono uppercase tracking-[0.08em] text-forest/70 mb-2">Neighbourhood</legend>
              <div className="flex flex-wrap gap-2">
                {neighbourhoods.map((value) => (
                  <label key={value} className="cursor-pointer">
                    <input type="checkbox" checked={draftNeighbourhoods.includes(value)} onChange={() => setDraftNeighbourhoods((values) => toggle(values, value))} className="peer sr-only" />
                    <span className="inline-flex rounded-full border border-forest/30 px-3 py-1.5 text-sm text-forest transition-colors peer-checked:border-picky-700 peer-checked:bg-picky-700 peer-checked:text-white">{value}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {cuisines.length > 0 && (
            <fieldset>
              <legend className="text-xs font-mono uppercase tracking-[0.08em] text-forest/70 mb-2">Cuisine</legend>
              <div className="flex flex-wrap gap-2">
                {cuisines.map((value) => (
                  <label key={value} className="cursor-pointer">
                    <input type="checkbox" checked={draftCuisines.includes(value)} onChange={() => setDraftCuisines((values) => toggle(values, value))} className="peer sr-only" />
                    <span className="inline-flex rounded-full border border-forest/30 px-3 py-1.5 text-sm text-forest transition-colors peer-checked:border-picky-700 peer-checked:bg-picky-700 peer-checked:text-white">{value}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          </div>
          <div className="mt-5 flex items-center gap-4">
            <button onClick={applyFilters} disabled={!filtersChanged} className="btn-cta disabled:cursor-not-allowed disabled:opacity-50">Apply filters</button>
            {(draftNeighbourhoods.length > 0 || draftCuisines.length > 0) && <button onClick={() => { setDraftNeighbourhoods([]); setDraftCuisines([]); }} className="text-sm text-picky-700 underline">Clear selections</button>}
          </div>
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
