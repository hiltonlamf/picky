'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import CityGuideList from './CityGuideList';
import { ChevronIcon } from './icons';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';
import { CITY_SWITCHER } from '@/lib/site-copy';
import type { CityGuide } from '@/types';

const PILL_CLASS =
  'glass inline-flex items-center gap-2.5 rounded-full px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase text-paper/90';

/**
 * The "Dublin, Ireland" pill in a guide hero, upgraded into a way out.
 *
 * Most visitors arrive on a guide page rather than the index, so this — not
 * /guides — is where a second city actually gets discovered. It tells you where
 * you are and what else is nearby, which is the whole job of local navigation.
 *
 * With only one guide to offer it renders as the plain pill it has always been:
 * a dropdown that opens onto nothing is worse than no dropdown.
 */
export default function CityGuideSwitcher({
  currentSlug,
  where,
  guides,
  showDraftBadge = false,
}: {
  currentSlug: string;
  /** "Dublin, Ireland" — the label already shown on the pill. */
  where: string;
  guides: CityGuide[];
  showDraftBadge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close(true);
    }
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) close(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  // Nothing to switch to — render exactly what was here before.
  if (guides.length < 2) {
    return (
      <span className={PILL_CLASS}>
        <span className="w-1.5 h-1.5 rounded-full bg-azalea-500 animate-blink" />
        {where}
      </span>
    );
  }

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={CITY_SWITCHER.label(where)}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) capture(EVENTS.CITY_SWITCHER_OPENED, { from_city: currentSlug });
        }}
        className={`${PILL_CLASS} transition-colors hover:bg-white/[0.18] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-400/30`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-azalea-500 animate-blink" />
        {where}
        <ChevronIcon
          className={`w-3.5 h-3.5 transition-transform duration-150 ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </button>

      {open && (
        <div
          id={panelId}
          // A dark scrim rather than plain .glass, for the same reason
          // .btn-ghost-glass carries one: paper text on clear glass over the
          // hero's mesh measures about 4.2:1. It also stops the panel smearing
          // over the white restaurant cards it can overlap.
          className="animate-rise absolute left-0 top-[calc(100%+10px)] z-30 w-[min(20rem,calc(100vw-3rem))] rounded-[20px] border border-white/[0.16] bg-forest-deep/95 p-4 shadow-[0_18px_44px_rgba(4,22,15,0.45)] backdrop-blur-md backdrop-saturate-150"
        >
          <p className="eyebrow-light mb-3">{CITY_SWITCHER.heading}</p>
          {/* Capped so a long list scrolls inside the panel rather than running
              off the bottom of the page. */}
          <div className="max-h-[min(55vh,22rem)] overflow-y-auto">
            <CityGuideList
              guides={guides}
              variant="switcher"
              currentSlug={currentSlug}
              showDraftBadge={showDraftBadge}
            />
          </div>
          <Link
            href="/guides"
            className="mt-4 block rounded-xl border border-azalea-400/45 bg-azalea-500/10 px-4 py-2.5 text-center font-display text-sm text-azalea-400 transition-colors hover:bg-azalea-500 hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-400/30"
            onClick={() => close(false)}
          >
            {CITY_SWITCHER.allGuides}
          </Link>
        </div>
      )}
    </div>
  );
}
