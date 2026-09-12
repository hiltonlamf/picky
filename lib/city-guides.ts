/**
 * Pure helpers for presenting the set of city guides.
 *
 * Deliberately free of DB and browser imports so both the server pages and the
 * client list component can use them, and so the ordering/grouping rules can be
 * unit-tested without a database. Nothing here calls the AI.
 */

import { countryFlag } from './site-copy';
import type { CityGuide } from '@/types';

/**
 * Above this many guides the list grows a filter box. Below it, typing to find
 * one of a handful of cities is pure friction — the grid IS the interface, and
 * an empty search box over three items reads as a broken page.
 */
export const GUIDE_FILTER_THRESHOLD = 12;

/**
 * Slugs a city guide may never take, because a static route of the same name
 * already exists and Next.js resolves it ahead of `app/[city]`. A guide created
 * on one of these would be permanently unreachable — the admin would publish it
 * and get the other page, with nothing to explain why.
 *
 * `_next` and `ingest` are not pages but are routed before us all the same.
 */
export const RESERVED_GUIDE_SLUGS: readonly string[] = [
  '_next',
  'admin',
  'api',
  'guides',
  'ingest',
  'legal',
  'privacy',
  'restaurant',
  'vote',
];

export function isReservedGuideSlug(slug: string): boolean {
  return RESERVED_GUIDE_SLUGS.includes(slug.trim().toLowerCase());
}

/** Heading for guides whose `country` is not set. Rare, but it must not read as
 *  a country called "null" — and the guides still have to appear somewhere. */
export const UNGROUPED_COUNTRY_LABEL = 'Elsewhere';

export interface CountryGroup<T extends CityGuide> {
  /** Display heading — the country name, or UNGROUPED_COUNTRY_LABEL. */
  country: string;
  /** Flag emoji, or null when the country is unknown to COUNTRY_FLAGS. */
  flag: string | null;
  guides: T[];
}

/**
 * Groups guides by country for display: countries alphabetical, cities
 * alphabetical within each, countryless guides last.
 *
 * Grouping from day one is what makes this scale — three Irish cities today
 * render as one "Ireland" group, and a hundred cities across a dozen countries
 * render the same way with no layout change.
 */
export function groupGuidesByCountry<T extends CityGuide>(guides: T[]): CountryGroup<T>[] {
  const byCountry = new Map<string, T[]>();
  for (const guide of guides) {
    const key = guide.country?.trim() || '';
    const bucket = byCountry.get(key);
    if (bucket) bucket.push(guide);
    else byCountry.set(key, [guide]);
  }

  const named = Array.from(byCountry.entries()).filter(([country]) => country !== '');
  named.sort(([a], [b]) => a.localeCompare(b));

  const groups: CountryGroup<T>[] = named.map(([country, list]) => ({
    country,
    flag: countryFlag(country),
    guides: sortByName(list),
  }));

  const unnamed = byCountry.get('');
  if (unnamed?.length) {
    groups.push({ country: UNGROUPED_COUNTRY_LABEL, flag: null, guides: sortByName(unnamed) });
  }
  return groups;
}

function sortByName<T extends CityGuide>(guides: T[]): T[] {
  return [...guides].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Strips accents and case so "Malaga" finds "Málaga" — a visitor typing on a
 * phone keyboard should not have to produce the right diacritic to find a city.
 */
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Filters guides on city name and country. An empty query matches everything. */
export function filterGuides<T extends CityGuide>(guides: T[], query: string): T[] {
  const needle = normalise(query);
  if (!needle) return guides;
  return guides.filter((guide) =>
    normalise(`${guide.displayName} ${guide.country ?? ''}`).includes(needle)
  );
}
