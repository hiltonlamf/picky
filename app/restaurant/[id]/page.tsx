'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { Restaurant, DietaryClassification, Dish as DishType, MenuSection as MenuSectionType } from '@/types';
import MenuSection from '@/components/MenuSection';
import FreshnessIndicator from '@/components/FreshnessIndicator';
import Disclaimer from '@/components/Disclaimer';
import ShareButton from '@/components/ShareButton';
import FeedbackModal from '@/components/FeedbackModal';
import FlagOutdatedButton from '@/components/FlagOutdatedButton';
import SubmitMenuForm from '@/components/SubmitMenuForm';
import { useHeader } from '@/lib/header-context';
import { capture } from '@/lib/posthog-client';
import { captureError, EVENTS } from '@/lib/analytics';
import { SITE_TITLE } from '@/lib/site-copy';
import CountingMethod from '@/components/CountingMethod';
import { isVeg, headlineCounts, menuTallies, makeCountedTest, guideInsights, type CategoryTally } from '@/lib/menu-insights';
import { SproutIcon, ShieldIcon, LeafOutlineIcon, AlertIcon, ChatIcon } from '@/components/icons';

type Filter = 'all' | 'vegan' | 'vegetarian';

const PENDING_POLL_MS = 4000;
// Cap the pending poll. Two problems with the previous unbounded loop: a tab
// left open re-hit the API every 4s indefinitely (small per call, unbounded in
// aggregate — the runaway-loop shape CLAUDE.md warns about), and a restaurant
// genuinely stuck in `processing` left the visitor on a spinner forever with no
// record that it had happened. 75 polls ~= 5 minutes, well past a normal
// analysis.
const MAX_PENDING_POLLS = 75;

/** Raw dish counts, kept ONLY for the results_viewed event so the funnel stays
 *  comparable across this change. Everything on screen uses menuTallies. */
function countDishes(sections: MenuSectionType[], filter: DietaryClassification | 'all') {
  const dishes = sections.flatMap((s) => s.dishes).filter((d) => !d.deletedAt);
  if (filter === 'all') return dishes.length;
  return dishes.filter((d) => {
    if (filter === 'vegan') return d.classification === 'vegan';
    if (filter === 'vegetarian') return isVeg(d);
    return false;
  }).length;
}

// Everything the page displays comes from menuTallies (lib/menu-insights),
// which the guide card uses too — so the two surfaces cannot disagree about
// what "N veggie" means, nor about which dishes are the same dish.

/**
 * A small aside line: how many of this category are sides, sauces or sweets.
 * Rendered under the capsule's number, and mirrored by the "+N" on the tab.
 */
function AsideNote({ count }: { count: number }) {
  if (count <= 0) return null;
  const s = count === 1 ? '' : 's';
  return (
    <div className="text-[0.68rem] leading-tight text-forest/55 mt-1">
      +{count} side{s}, sauce{s} &amp; sweet{s}
    </div>
  );
}

/**
 * Where this visit came from, so a result can be attributed to the search box,
 * a city guide, or a shared link. Derived from the share marker first (explicit
 * and reliable), then the referrer path.
 */
function arrivalSource(): 'share' | 'guide' | 'search' | 'direct' {
  if (typeof window === 'undefined') return 'direct';
  if (new URLSearchParams(window.location.search).get('ref') === 'share') return 'share';
  const ref = document.referrer;
  if (!ref) return 'direct';
  try {
    const url = new URL(ref);
    if (url.origin !== window.location.origin) return 'direct';
    // A guide lives at /<city>; the search box lives at the root.
    if (url.pathname === '/') return 'search';
    if (/^\/[a-z0-9-]+\/?$/i.test(url.pathname)) return 'guide';
    return 'direct';
  } catch {
    return 'direct';
  }
}

/** Distinct source-menu labels (Lunch/Dinner/...) in display order; empty for single-menu restaurants. */
function distinctMenuLabels(restaurant: Restaurant): string[] {
  const labels: string[] = [];
  for (const s of restaurant.sections) {
    if (s.menuLabel && !labels.includes(s.menuLabel)) labels.push(s.menuLabel);
  }
  return labels;
}

export default function RestaurantPage() {
  const params = useParams<{ id: string }>();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('vegetarian');
  // 'all' or a specific source-menu label (Lunch/Dinner/...) when the
  // restaurant has multiple analysed menus. Defaults to 'all' only until the
  // data arrives — see the effect below, which switches to the menu the guide
  // card headlines.
  const [menuFilter, setMenuFilter] = useState<string>('all');
  // Whether the user has picked a menu themselves; their choice always wins
  // over the default.
  const menuChosen = useRef(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { setRestaurantName } = useHeader();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // results_viewed must fire once per visit, not once per poll tick — the page
  // re-fetches every few seconds while the AI is still working.
  const reportedOutcome = useRef(false);
  const pollCount = useRef(0);
  // Fired once when the visitor first actually engages with the menu, so
  // "saw a result" and "used a result" stay distinguishable.
  const reportedEngagement = useRef(false);

  /**
   * Fired once per visit on the first real interaction with the menu. Separates
   * "saw a result" from "used a result" — a high results_viewed with a low
   * engagement rate means the menus are loading but aren't useful, which a
   * pageview count alone would hide.
   */
  const reportEngagement = useCallback(
    (trigger: string) => {
      if (reportedEngagement.current) return;
      reportedEngagement.current = true;
      capture(EVENTS.RESULTS_ENGAGED, { restaurant_id: params.id, trigger });
    },
    [params.id]
  );

  const load = useCallback(() => {
    // no-store so a returning visitor never sees a browser-cached snapshot after
    // an admin edit (rename/reclassify/removal) — the route is force-dynamic too.
    fetch(`/api/restaurants/${params.id}`, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('Restaurant not found');
        return r.json();
      })
      .then((data: Restaurant) => {
        setRestaurant(data);
        // The default menu is chosen in an effect below (the one the guide card
        // headlines), not here — this used to pick labels[0], which is why the
        // page opened on Sunday Menu while the card talked about the Main one.
        if (data.name) {
          setRestaurantName(data.name);
          document.title = `${data.name} | Platefully`;
        }
        setLoading(false);

        // While the AI is still working, keep checking without asking the
        // user to refresh manually — DB reads only, no extra AI cost.
        if (data.status === 'pending' || data.status === 'processing') {
          if (pollCount.current < MAX_PENDING_POLLS) {
            pollCount.current += 1;
            pollTimer.current = setTimeout(load, PENDING_POLL_MS);
            return;
          }
          // Give up rather than spin forever, and say so — a silent permanent
          // spinner is the worst version of this for the visitor, and it was
          // also invisible to us.
          if (!reportedOutcome.current) {
            reportedOutcome.current = true;
            captureError({
              surface: 'results_stuck_pending',
              code: 'timeout',
              message: `Still ${data.status} after ${Math.round((MAX_PENDING_POLLS * PENDING_POLL_MS) / 1000)}s`,
              restaurantId: params.id,
              extra: { source: arrivalSource() },
            });
          }
          setError(
            "This is taking much longer than usual. The analysis may still finish — try reloading in a minute."
          );
          return;
        }

        // The single most important event in the funnel: it's what turns
        // "someone searched" into "someone actually got a menu", and it closes
        // the search, guide and share funnels alike. Fired only on a terminal
        // status, once per visit — firing on each poll tick would inflate the
        // step and break every conversion rate built on it.
        if (!reportedOutcome.current) {
          reportedOutcome.current = true;
          const dishCount = countDishes(data.sections, 'all');
          capture(EVENTS.RESULTS_VIEWED, {
            restaurant_id: params.id,
            outcome: data.status === 'done' ? 'menu' : data.status,
            dish_count: dishCount,
            vegan_count: countDishes(data.sections, 'vegan'),
            // Kept on the OLD definition (every veg dish, sides included) so
            // charts built on it stay comparable across this change rather than
            // silently re-baselining. The new headline figures ride alongside.
            veg_count: countDishes(data.sections, 'vegetarian'),
            veg_counted: headlineCounts(data.sections).counted,
            veg_aside: headlineCounts(data.sections).aside,
            menu_count: distinctMenuLabels(data).length,
            source: arrivalSource(),
            // Only set on a no_menu outcome; it's what separates "site is
            // down" from "site has no menu online", which need different fixes.
            no_menu_reason: data.noMenuReason ?? null,
            // The thin-menu tripwire, on live user traffic rather than only in
            // admin review: a real menu with 3 dishes is a bug, not a result.
            is_thin: data.status === 'done' && dishCount > 0 && dishCount < 7,
          });
        }
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
        // Was silent before: the visitor got a "Restaurant not found" screen
        // and we had no record it ever happened.
        captureError({
          surface: 'results',
          message: err instanceof Error ? err.message : String(err),
          restaurantId: params.id,
        });
      });
  }, [params.id, setRestaurantName]);

  useEffect(() => {
    load();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      setRestaurantName(null);
      document.title = SITE_TITLE;
    };
  }, [load, setRestaurantName]);

  /**
   * Land on the menu the guide card is talking about.
   *
   * The card headlines the BEST SINGLE menu, because a diner only eats off one
   * menu per visit — but this page opened on "All menus", which sums them. Fade
   * Street Social's card read "9 veggie" while the page showed a different
   * number entirely, and neither was wrong; they were answering different
   * questions. Now both describe the same menu, and "All menus" is one click
   * away for anyone who wants the whole picture.
   */
  useEffect(() => {
    if (!restaurant || menuChosen.current) return;
    if (distinctMenuLabels(restaurant).length <= 1) return;
    const best = guideInsights(restaurant).bestMenu.label;
    if (best) setMenuFilter(best);
  }, [restaurant]);

  // Closes the share loop: shared links carry ?ref=share&src=<channel>
  // (set in ShareButton), so share → visit → activation is measurable.
  // window.location instead of useSearchParams to avoid a Suspense boundary.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (search.get('ref') === 'share') {
      capture('share_landing', {
        channel: search.get('src') ?? 'unknown',
        restaurant_id: params.id,
      });
    }
  }, [params.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <SproutIcon className="w-10 h-10 mx-auto mb-3 text-picky-500 animate-pulse-gentle" />
          <p className="text-evergreen/80 text-sm">Loading menu...</p>
        </div>
      </div>
    );
  }

  if (error || !restaurant) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <QuestionMark />
        <h1 className="font-display text-2xl text-forest mb-2">Restaurant not found</h1>
        <p className="text-forest/80 mb-6">{error ?? "This restaurant doesn't exist or was removed."}</p>
        <Link href="/" className="btn-cta inline-block">
          ← Back to search
        </Link>
      </div>
    );
  }

  if (restaurant.status === 'no_menu') {
    const name = restaurant.name ?? 'this restaurant';
    const reason = restaurant.noMenuReason ?? 'not_listed';
    const copy =
      reason === 'unavailable'
        ? {
            heading: 'This website looks down',
            body: `We couldn't reach ${name}'s website — it may be down or not live yet.`,
          }
        : reason === 'closed'
        ? {
            heading: 'This restaurant looks closed',
            body: `${name} appears to be permanently closed, so there's no menu to show.`,
          }
        : // 'blocked' means we FOUND the menu and were refused it — a fact about
          // the host, not about the restaurant. Saying "no menu listed" here
          // would be simply untrue, and it hides the one thing that fixes it.
          reason === 'blocked'
          ? {
              heading: "We found the menu — but we can't open it",
              body:
                'Some things on the web are off-limits to AI agents: either we cannot read them, or ' +
                'we are not permitted to. Can you give us a hand by uploading the menu, or pasting a ' +
                "direct link? We'll read it right away.",
            }
          : {
              heading: 'No menu listed on this site',
              body: `We looked, but ${name}'s website doesn't seem to publish a menu online.`,
            };
    return (
      <div className="max-w-lg mx-auto px-4 py-16">
        <div className="text-center mb-6">
          <LeafOutlineIcon className="w-12 h-12 mx-auto mb-4 text-picky-500" />
          <h1 className="font-display text-2xl text-forest mb-2">{copy.heading}</h1>
          <p className="text-evergreen/80">{copy.body}</p>
        </div>
        <SubmitMenuForm restaurantId={restaurant.id} />
        <div className="text-center mt-6">
          <Link href="/" className="btn-ghost text-sm">
            ← Try a different restaurant
          </Link>
        </div>
      </div>
    );
  }

  if (restaurant.status === 'error') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <AlertIcon className="w-12 h-12 mx-auto mb-4 text-sun-400" />
        <h1 className="font-display text-2xl text-forest mb-2">Couldn&apos;t read this menu</h1>
        <p className="text-evergreen/80 mb-2">
          {restaurant.errorMessage ?? 'An error occurred while parsing this restaurant.'}
        </p>
        <p className="text-sm text-evergreen/80 mb-6">
          The menu may be temporarily unavailable, or this website may require JavaScript to load.
        </p>
        <Link href="/" className="btn-cta inline-block">
          ← Try a different link
        </Link>
      </div>
    );
  }

  if (restaurant.status === 'pending' || restaurant.status === 'processing') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <SproutIcon className="w-12 h-12 mx-auto mb-4 text-picky-500 animate-pulse-gentle" />
        <h1 className="font-display text-2xl text-forest mb-2">
          Reading {restaurant.name ?? 'this menu'}&hellip;
        </h1>
        <p className="text-evergreen/80 mb-6">
          Usually under a minute — this page updates itself the moment it&apos;s ready.
        </p>
        <Link href="/dublin" className="btn-guide">
          ← Back to Dublin Guide
        </Link>
      </div>
    );
  }

  const menuLabels = distinctMenuLabels(restaurant);
  // Unlabeled sections (e.g. unsectioned dishes) are shown in every view.
  const visibleSections =
    menuLabels.length > 1 && menuFilter !== 'all'
      ? restaurant.sections.filter((s) => s.menuLabel === menuFilter || !s.menuLabel)
      : restaurant.sections;

  // ONE tally, feeding BOTH the stat capsules and the filter tabs, from the
  // same helper the guide card uses. Two bugs came from computing it here
  // instead: the capsule showed the counted figure while the tab showed the
  // whole list (Etto: "1 Vegan" above a "Vegan 4" button), and a hand-rolled
  // walk skipped the de-duplication (Fade Street: card 9, page 10).
  //
  // The price level comes from the WHOLE restaurant, not the visible menu —
  // guideInsights does the same, and judging a cheap lunch menu against itself
  // gives a different answer.
  const tallies = menuTallies(visibleSections, restaurant.sections);

  // Marks the sides/sweets in the list itself, so the "+N" on the tab has
  // something to point at. Same price context as the tally above.
  const countedTest = makeCountedTest(restaurant.sections);
  const isAsideDish = (sectionName: string, dish: DishType) =>
    isVeg(dish) && !countedTest(sectionName, dish);

  // One order everywhere: broadest first, narrowest last.
  const filters: { value: Filter; label: string; tally: CategoryTally }[] = [
    { value: 'all', label: '🍽️ All dishes', tally: { counted: tallies.all, aside: 0 } },
    { value: 'vegetarian', label: '🍳 Veggie', tally: tallies.veg },
    { value: 'vegan', label: '🌱 Vegan', tally: tallies.vegan },
  ];
  const activeTally = filters.find((f) => f.value === filter)!.tally;

  return (
    <div className="relative">
      {/* An ambient mesh field so the glass surfaces have something to refract.
          It lives OUTSIDE the max-width column so it spans the full viewport —
          inside it, it rendered as a tinted stripe the width of the content. */}
      <div
        className="absolute inset-x-0 top-0 h-[560px] overflow-hidden pointer-events-none"
        aria-hidden="true"
      >
        <div className="mesh">
          <span className="w-[60%] h-[70%] left-[-14%] top-[-18%] bg-picky-400 opacity-[0.16]" />
          <span className="w-[50%] h-[62%] left-[58%] top-[-12%] bg-azalea-500 opacity-[0.13]" />
        </div>
        <div className="grain opacity-[0.06]" />
      </div>

      <div className="relative max-w-2xl mx-auto px-4 py-8">
      {/* Back */}
      <Link
        href="/"
        className="relative z-[2] inline-flex items-center gap-1.5 text-sm text-forest/75 hover:text-forest mb-6"
      >
        ← Back to search
      </Link>

      {/* Header */}
      <div className="relative z-[2] mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-display text-[clamp(1.7rem,4vw,2.3rem)] leading-[1.05] tracking-[-0.025em] text-forest">
            {restaurant.name ?? 'Restaurant Menu'}
          </h1>
          <div className="shrink-0 pt-0.5 flex items-center gap-2">
            <button
              onClick={() => { reportEngagement('feedback'); setFeedbackOpen(true); capture('feedback_modal_opened', { restaurant_id: restaurant.id }); }}
              className="glass-light inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-forest/90 hover:text-forest transition-colors"
            >
              <ChatIcon className="w-4 h-4" />
              Feedback
            </button>
            <ShareButton restaurant={restaurant} visibleSections={visibleSections} />
          </div>
        </div>
        {restaurant.cuisine && (
          <p className="text-xs font-mono uppercase tracking-[0.08em] text-evergreen/50 mt-1">{restaurant.cuisine}</p>
        )}
        {(restaurant.locations?.length ?? 0) > 0 ? (
          <div className="mt-2 text-sm text-forest/70">
            {restaurant.locations!.length > 1 && <p className="font-medium text-forest/80">Locations</p>}
            <ul className={restaurant.locations!.length > 1 ? 'mt-1 space-y-1' : ''}>
              {restaurant.locations!.map((location, index) => (
                <li key={location.id ?? `${location.address}-${index}`}>
                  {location.label && location.label.toLowerCase() !== restaurant.name?.toLowerCase() && (
                    <span className="font-medium">{location.label}: </span>
                  )}
                  {location.address}
                </li>
              ))}
            </ul>
          </div>
        ) : restaurant.address ? (
          <p className="text-sm text-forest/70 mt-2">{restaurant.address}</p>
        ) : null}
        {/* Links out: the restaurant's own site, and the specific menu page when
            we have one (some sites publish no direct menu link — then it's hidden). */}
        <div className="mt-1 flex items-center gap-3 flex-wrap">
          {(restaurant.canonicalUrl || restaurant.url) && (
            <a
              href={restaurant.url || restaurant.canonicalUrl || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-picky-600 hover:underline"
            >
              Visit website ↗
            </a>
          )}
          {restaurant.menuUrl && (
            <a
              href={restaurant.menuUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-picky-600 hover:underline"
            >
              View original menu ↗
            </a>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <FreshnessIndicator lastScrapedAt={restaurant.lastScrapedAt} />
          <FlagOutdatedButton restaurantId={restaurant.id} restaurantName={restaurant.name ?? null} />
        </div>
      </div>

      {/* How this page was produced — honest about the AI's fallibility. */}
      <div className="glass-light flex items-start gap-3 rounded-2xl px-4 py-3.5 mb-6 text-sm text-forest/90">
        <ShieldIcon className="w-4 h-4 flex-shrink-0 mt-0.5 text-azalea-700" />
        <span>
          AI can make errors. We sample and review some results by hand, and are trying our best to
          improve the accuracy. Spot something off? Tap the flag on any dish to report it.
        </span>
      </div>

      {/* Stats — glass capsules over the mesh, but the numbers themselves stay
          solid green: dietary information must never lose contrast to an effect. */}
      <div className="grid grid-cols-3 gap-3 mb-2">
        <div className="glass-light rounded-2xl p-3.5 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🍽️</div>
          <div className="font-display text-3xl text-forest/80">{tallies.all}</div>
          <div className="text-xs text-forest/75 mt-0.5">All dishes</div>
        </div>
        <div className="glass-light rounded-2xl p-3.5 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🍳</div>
          <div className="font-display text-3xl text-picky-600">{tallies.veg.counted}</div>
          <div className="text-xs text-forest/75 mt-0.5">Veggie</div>
          <AsideNote count={tallies.veg.aside} />
        </div>
        <div className="glass-light rounded-2xl p-3.5 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🌱</div>
          <div className="font-display text-3xl text-picky-700">{tallies.vegan.counted}</div>
          <div className="text-xs text-forest/75 mt-0.5">Vegan</div>
          <AsideNote count={tallies.vegan.aside} />
        </div>
      </div>

      {/* The number leaves things out on purpose, so it has to say so. */}
      <div className="relative z-[2] mb-6">
        <CountingMethod surface="restaurant" />
      </div>

      {/* Menu selector — only when multiple menus were analysed */}
      {menuLabels.length > 1 && (
        <div className="relative z-[2] mb-4">
          <label htmlFor="menu-select" className="block text-xs font-medium text-forest/75 mb-1.5">
            Menu
          </label>
          <select
            id="menu-select"
            value={menuFilter}
            onChange={(e) => { menuChosen.current = true; reportEngagement('menu_filter'); setMenuFilter(e.target.value); capture('menu_filter_changed', { menu_label: e.target.value, restaurant_id: params.id }); }}
            className="glass-light w-full sm:w-auto px-4 py-2.5 rounded-full text-sm font-medium text-forest focus:outline-none focus:ring-4 focus:ring-azalea-500/25"
          >
            {menuLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
            <option value="all">All menus</option>
          </select>
        </div>
      )}

      {/* Filter tabs — glass when idle, solid forest when active so the current
          filter is never ambiguous. */}
      <div className="relative z-[2] flex gap-2 mb-6 overflow-x-auto pb-1">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => { reportEngagement('diet_filter'); setFilter(f.value); capture('filter_changed', { filter: f.value, restaurant_id: params.id }); }}
            className={`flex-shrink-0 px-4 py-2.5 rounded-full text-sm font-semibold transition-colors duration-150 ${
              filter === f.value
                ? 'bg-forest text-paper border-2 border-forest'
                : 'glass-light text-forest/85 hover:text-forest'
            }`}
          >
            {f.label}
            <span className={`ml-1.5 text-xs ${filter === f.value ? 'text-azalea-400' : 'text-forest/70'}`}>
              {f.tally.counted}
              {/* The sides/sweets are still IN this list — the badge has to
                  account for them or it contradicts the rows below it. */}
              {f.tally.aside > 0 && (
                <span className={filter === f.value ? 'text-paper/55' : 'text-forest/45'}>
                  {' '}+{f.tally.aside}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* The badge says 4 and the list shows nine rows; without this the
          difference is unexplained. Names the count and points at the label
          that marks the rest. */}
      {filter !== 'all' && activeTally.aside > 0 && (
        <p className="relative z-[2] -mt-4 mb-6 text-xs text-forest/65">
          <strong className="font-semibold text-forest/80">{activeTally.counted}</strong>{' '}
          {filter === 'vegan' ? 'vegan' : 'veggie'} dish
          {activeTally.counted === 1 ? '' : 'es'} we count, plus {activeTally.aside} side
          {activeTally.aside === 1 ? '' : 's'}, sauce{activeTally.aside === 1 ? '' : 's'} &amp;
          sweet{activeTally.aside === 1 ? '' : 's'} marked{' '}
          <em>not included in the veggie count</em> below.
        </p>
      )}

      {/* Menu sections */}
      {visibleSections.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-evergreen/80">No menu sections found for this restaurant.</p>
        </div>
      ) : menuLabels.length > 1 && menuFilter === 'all' ? (
        // "All menus" view: group sections under a heading per source menu.
        <>
          {menuLabels.map((label) => {
            const group = visibleSections.filter((s) => s.menuLabel === label);
            if (group.length === 0) return null;
            return (
              <div key={label} className="mb-8">
                <h2 className="font-display text-xl text-forest mb-3 pb-2 border-b-[1.5px] border-forest/15">{label}</h2>
                {group.map((section) => (
                  <MenuSection key={section.id} section={section} activeFilter={filter} isAside={isAsideDish} />
                ))}
              </div>
            );
          })}
          {visibleSections
            .filter((s) => !s.menuLabel)
            .map((section) => (
              <MenuSection key={section.id} section={section} activeFilter={filter} isAside={isAsideDish} />
            ))}
        </>
      ) : (
        <>
          {visibleSections.map((section) => (
            <MenuSection key={section.id} section={section} activeFilter={filter} isAside={isAsideDish} />
          ))}
        </>
      )}

      {/* Disclaimer */}
      <div className="mt-8">
        <Disclaimer />
      </div>

      {feedbackOpen && (
        <FeedbackModal
          restaurantId={restaurant.id}
          restaurantName={restaurant.name ?? null}
          onClose={() => setFeedbackOpen(false)}
          menuLabels={menuLabels}
          currentMenuLabel={menuFilter !== 'all' ? menuFilter : null}
        />
      )}
      </div>
    </div>
  );
}

function QuestionMark() {
  return (
    <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-mint-100 flex items-center justify-center">
      <LeafOutlineIcon className="w-6 h-6 text-evergreen/80" />
    </div>
  );
}
