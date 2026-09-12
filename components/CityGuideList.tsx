'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import GuideCtaLink from './GuideCtaLink';
import { SearchIcon } from './icons';
import {
  GUIDE_FILTER_THRESHOLD,
  filterGuides,
  groupGuidesByCountry,
} from '@/lib/city-guides';
import { CITY_SWITCHER, GUIDE_INDEX } from '@/lib/site-copy';
import type { CityGuide } from '@/types';

export type CityGuideListItem = CityGuide;

/**
 * The one list of city guides, rendered in two places: the /guides hub and the
 * switcher inside a guide page's hero.
 *
 * Sharing the component is the point. It groups by country and grows a filter
 * box at the same threshold on both surfaces, so the day there are two hundred
 * guides, both scale together — rather than one of them quietly becoming an
 * unusable wall of links.
 */
export default function CityGuideList({
  guides,
  variant,
  currentSlug,
  showDraftBadge = false,
}: {
  guides: CityGuideListItem[];
  variant: 'hub' | 'switcher';
  /** The city being viewed, marked in place rather than hidden — a switcher
   *  that silently drops the current city loses the visitor's bearings. */
  currentSlug?: string;
  /** Drafts are only ever passed in for a signed-in admin; this labels them. */
  showDraftBadge?: boolean;
}) {
  const [query, setQuery] = useState('');
  const inputId = useId();

  // Typing to find one of three cities is friction, so the box only appears
  // once the list is genuinely long enough to need it.
  const showFilter = guides.length > GUIDE_FILTER_THRESHOLD;
  const visible = useMemo(
    () => (showFilter ? filterGuides(guides, query) : guides),
    [guides, query, showFilter]
  );
  const groups = useMemo(() => groupGuidesByCountry(visible), [visible]);

  const dark = variant === 'switcher';

  return (
    <div>
      {showFilter && (
        <div className="mb-8" role="search">
          <label
            htmlFor={inputId}
            className={dark ? 'eyebrow-light block mb-2' : 'eyebrow-pink block mb-2'}
          >
            {GUIDE_INDEX.filterLabel}
          </label>
          <div className="relative max-w-md">
            <SearchIcon
              className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 ${
                dark ? 'text-paper/55' : 'text-forest/45'
              }`}
            />
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={GUIDE_INDEX.filterPlaceholder}
              className="w-full rounded-full border-2 border-paper-line bg-white pl-12 pr-5 py-3 text-forest placeholder-forest/50 focus:border-azalea-500 focus:outline-none focus:ring-4 focus:ring-azalea-500/20 transition-all duration-150"
            />
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <p className={`text-sm ${dark ? 'text-paper/75' : 'text-forest/70'}`}>{GUIDE_INDEX.empty}</p>
      ) : (
        <div className={variant === 'hub' ? 'space-y-10' : 'space-y-5'}>
          {groups.map((group) => (
            <section key={group.country} aria-label={group.country}>
              <h3
                className={`flex items-center gap-2 ${
                  dark
                    ? 'font-mono text-[11px] tracking-[0.16em] uppercase text-paper/60'
                    : 'font-display text-lg text-forest'
                } mb-3`}
              >
                {group.flag && (
                  <span role="img" aria-hidden="true">
                    {group.flag}
                  </span>
                )}
                {group.country}
              </h3>

              {variant === 'hub' ? (
                <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 list-none p-0 m-0">
                  {group.guides.map((guide) => (
                    <li key={guide.slug}>
                      <HubTile guide={guide} showDraftBadge={showDraftBadge} />
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="list-none p-0 m-0 space-y-1">
                  {group.guides.map((guide) => (
                    <li key={guide.slug}>
                      <SwitcherRow
                        guide={guide}
                        isCurrent={guide.slug === currentSlug}
                        showDraftBadge={showDraftBadge}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** A city tile on /guides. Same shape language as RestaurantCard, so a city and
 *  a restaurant read as members of one family. */
function HubTile({
  guide,
  showDraftBadge,
}: {
  guide: CityGuideListItem;
  showDraftBadge: boolean;
}) {
  const isDraft = guide.status !== 'published';
  return (
    <GuideCtaLink
      href={`/${guide.slug}`}
      city={guide.slug}
      placement="index"
      className="group flex h-full flex-col gap-1 rounded-[20px] border-2 border-forest bg-white p-5 transition-all duration-150 hover:-translate-y-[3px] hover:border-azalea-500 hover:shadow-card-pop focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-500/25"
      label={
        <>
          <span className="font-display text-xl leading-tight text-forest">
            {guide.displayName}
          </span>
          {guide.country && (
            <span className="font-mono text-[11px] tracking-[0.09em] uppercase text-forest/60">
              {guide.country}
            </span>
          )}
          {isDraft && showDraftBadge && (
            <span className="mt-2 self-start rounded-full bg-sun-50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-sun-800">
              {GUIDE_INDEX.draftBadge}
            </span>
          )}
        </>
      }
    />
  );
}

/** A row inside the guide-page switcher. Plain navigation, so deliberately NOT
 *  a GuideCtaLink — folding navigation into the CTA event would make its
 *  `placement` breakdown meaningless. */
function SwitcherRow({
  guide,
  isCurrent,
  showDraftBadge,
}: {
  guide: CityGuideListItem;
  isCurrent: boolean;
  showDraftBadge: boolean;
}) {
  const isDraft = guide.status !== 'published';
  const draftBadge = isDraft && showDraftBadge && (
    <span className="rounded-full bg-sun-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-sun-800">
      Draft
    </span>
  );

  if (isCurrent) {
    return (
      <span
        aria-current="page"
        className="flex items-center justify-between gap-3 rounded-xl border border-paper/25 bg-white/[0.12] px-4 py-2.5 text-paper"
      >
        <span className="font-display">{guide.displayName}</span>
        <span className="flex items-center gap-2">
          {draftBadge}
          {/* A visible label, not a hover title — hover is invisible on touch. */}
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-paper/70">
            {CITY_SWITCHER.current}
          </span>
        </span>
      </span>
    );
  }

  return (
    <Link
      href={`/${guide.slug}`}
      className="flex items-center justify-between gap-3 rounded-xl border border-transparent px-4 py-2.5 text-paper/85 transition-colors hover:border-paper/25 hover:bg-white/[0.1] hover:text-paper focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-400/30"
    >
      <span className="font-display">{guide.displayName}</span>
      {draftBadge}
    </Link>
  );
}
