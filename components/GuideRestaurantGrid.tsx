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

function updateUrl(pathname: string, current: URLSearchParams, areas: string[], cuisines: string[]) {
  const next = new URLSearchParams(current.toString());
  if (areas.length) next.set('area', areas.join(','));
  else next.delete('area');
  if (cuisines.length) next.set('cuisine', cuisines.join(','));
  else next.delete('cuisine');
  return next.toString() ? `${pathname}?${next}` : pathname;
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function MultiSelectDropdown({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const selection = selected.length ? ` (${selected.length})` : '';
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl border border-forest/25 bg-white px-3.5 py-2.5 text-sm font-medium text-forest marker:content-none hover:border-picky-700">
        {label}{selection}
        <span aria-hidden="true" className="text-forest/60 transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <fieldset className="absolute z-20 mt-2 max-h-72 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-forest/20 bg-white p-2 shadow-lg">
        <legend className="sr-only">{label}</legend>
        {values.map((value) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-sm text-forest hover:bg-mint-50">
            <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} className="mt-0.5 h-4 w-4 accent-picky-700" />
            <span>{value}</span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}

export default function GuideRestaurantGrid({ restaurants }: { restaurants: Restaurant[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedAreas = selectedValues(searchParams, 'area');
  const selectedCuisines = selectedValues(searchParams, 'cuisine');
  const [draftAreas, setDraftAreas] = useState(selectedAreas);
  const [draftCuisines, setDraftCuisines] = useState(selectedCuisines);
  const areas = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.area).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const cuisines = useMemo(
    () => Array.from(new Set(restaurants.map((r) => r.cuisine).filter((v): v is string => !!v))).sort(),
    [restaurants]
  );
  const filtered = restaurants.filter(
    (r) =>
      (!selectedAreas.length || (!!r.area && selectedAreas.includes(r.area))) &&
      (!selectedCuisines.length || (!!r.cuisine && selectedCuisines.includes(r.cuisine)))
  );
  const filtersChanged =
    draftAreas.join('|') !== selectedAreas.join('|') ||
    draftCuisines.join('|') !== selectedCuisines.join('|');
  const filterPrompt = areas.length > 0 && cuisines.length > 0
    ? 'Choose one or more areas and cuisines, then apply your filters.'
    : areas.length > 0
      ? 'Choose one or more areas, then apply your filters.'
      : 'Choose one or more cuisines, then apply your filters.';
  useEffect(() => {
    setDraftAreas(selectedAreas);
    setDraftCuisines(selectedCuisines);
    // URL is the shareable source of truth after navigation/back/forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const applyFilters = () => {
    capture(EVENTS.GUIDE_FILTER_CHANGED, {
      city: pathname.split('/')[1] ?? null,
      area_count: draftAreas.length,
      cuisine_count: draftCuisines.length,
    });
    router.replace(updateUrl(pathname, searchParams, draftAreas, draftCuisines), { scroll: false });
  };

  return (
    <section aria-label="Restaurant filters" className="mb-6">
      {(areas.length > 0 || cuisines.length > 0) && (
        <div className="card p-4 mb-5">
          <p className="text-sm text-forest/75 mb-4">{filterPrompt}</p>
          <div className="flex flex-wrap gap-3">
          {areas.length > 0 && (
            <MultiSelectDropdown label="Area" values={areas} selected={draftAreas} onToggle={(value) => setDraftAreas((values) => toggle(values, value))} />
          )}
          {cuisines.length > 0 && (
            <MultiSelectDropdown label="Cuisine" values={cuisines} selected={draftCuisines} onToggle={(value) => setDraftCuisines((values) => toggle(values, value))} />
          )}
          </div>
          <div className="mt-5 flex items-center gap-4">
            <button onClick={applyFilters} disabled={!filtersChanged} className="btn-cta disabled:cursor-not-allowed disabled:opacity-50">Apply filters</button>
            {(draftAreas.length > 0 || draftCuisines.length > 0) && <button onClick={() => { setDraftAreas([]); setDraftCuisines([]); }} className="text-sm text-picky-700 underline">Clear selections</button>}
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
