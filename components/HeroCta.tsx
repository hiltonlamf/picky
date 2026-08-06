'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import HeroSearch from './HeroSearch';
import GuideCtaLink from './GuideCtaLink';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';
import { HERO } from '@/lib/home-copy';

const PANEL_ID = 'hero-search-panel';

/**
 * The hero's two calls to action.
 *
 * The city guide leads. Checking one restaurant is something anyone can do by
 * opening its website — the app earns its keep across many menus at once, so
 * the finished guide is the better first offer than an empty box asking the
 * visitor to supply the input. Search is one click behind the secondary button.
 *
 * Both CTAs disappear once the search panel opens, leaving only the panel
 * itself on screen — founder's call, to avoid two competing asks at once.
 *
 * Split out of HeroSearch on purpose: that component carries the SSE reader and
 * the abandonment-metric refs, and keeping the disclosure out of it means its
 * diff stays small enough to review against those.
 */
export default function HeroCta() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deepLinkHandled = useRef(false);
  // Set only when a close should move focus back to the trigger. Without it,
  // focus would fall to <body> and a keyboard user would lose their place.
  const refocusTrigger = useRef(false);

  const openPanel = useCallback((source: 'hero_trigger' | 'deeplink') => {
    setOpen(true);
    capture(EVENTS.SEARCH_DISCLOSED, { source });
  }, []);

  const closePanel = useCallback(() => {
    refocusTrigger.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open && refocusTrigger.current) {
      refocusTrigger.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  /**
   * Deep link: /?search=1 or /#search opens straight into the URL bar, so the
   * guide's "Don't see your restaurant?" card lands people ready to paste
   * rather than on a page where the thing it promised is hidden.
   *
   * Read from window rather than useSearchParams(): this page is statically
   * rendered (revalidate = 300), and useSearchParams() in a client component
   * under a static route fails the build unless it is wrapped in <Suspense> —
   * while reading searchParams on the server would opt the whole homepage into
   * dynamic rendering and drop the 5-minute cache for everyone. One frame of
   * delay on a panel nobody is looking at yet costs nothing.
   */
  useEffect(() => {
    if (deepLinkHandled.current) return; // StrictMode runs effects twice in dev
    const wants =
      new URLSearchParams(window.location.search).get('search') === '1' ||
      window.location.hash === '#search';
    if (!wants) return;
    deepLinkHandled.current = true;
    openPanel('deeplink');
  }, [openPanel]);

  return (
    <div className="mt-8">
      {/* Both CTAs are unmounted (not just styled down) once the panel is open —
          founder's call: with only one thing to do at a time on screen, showing
          "explore the guide" next to an open search box read as confusing. The
          only ways back are Cancel and Escape, both of which exist solely in
          HeroSearch's idle branch, so this can never orphan a live analysis. */}
      {!open && (
        <div className="flex flex-wrap items-center gap-3">
          {/* Pink per founder's request — a deliberate exception to the
              pink-does/green-goes convention elsewhere on the site. Same
              .btn-cta treatment as "Find my veggies" so the two catchy pink
              pills read as a family. */}
          <GuideCtaLink
            href="/dublin"
            label={HERO.guideCta}
            city="dublin"
            placement="hero"
            className="btn-cta"
          />

          <button
            ref={triggerRef}
            type="button"
            className="btn-ghost-glass"
            aria-expanded={false}
            aria-controls={PANEL_ID}
            onClick={() => openPanel('hero_trigger')}
          >
            {HERO.searchTrigger}
          </button>
        </div>
      )}

      {/* Always rendered so aria-controls resolves even while collapsed. */}
      <div id={PANEL_ID}>
        {open && (
          <div className="animate-rise">
            <p className="mt-6 text-[1.02rem] leading-relaxed text-azalea-400 font-semibold">
              {HERO.searchHint}
            </p>
            <HeroSearch autoFocusInput onCancel={closePanel} cancelLabel={HERO.searchCancel} />
          </div>
        )}
      </div>
    </div>
  );
}
