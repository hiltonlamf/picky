'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { Restaurant, DietaryClassification, MenuSection as MenuSectionType } from '@/types';
import MenuSection from '@/components/MenuSection';
import FreshnessIndicator from '@/components/FreshnessIndicator';
import Disclaimer from '@/components/Disclaimer';
import ShareButton from '@/components/ShareButton';
import FeedbackModal from '@/components/FeedbackModal';
import FlagOutdatedButton from '@/components/FlagOutdatedButton';
import SubmitMenuForm from '@/components/SubmitMenuForm';
import { useHeader } from '@/lib/header-context';
import { capture } from '@/lib/posthog-client';
import { SproutIcon, ShieldIcon, LeafOutlineIcon, AlertIcon, ChatIcon } from '@/components/icons';

type Filter = 'all' | 'vegan' | 'vegetarian';

const PENDING_POLL_MS = 4000;

function countDishes(sections: MenuSectionType[], filter: DietaryClassification | 'all') {
  const dishes = sections.flatMap((s) => s.dishes);
  if (filter === 'all') return dishes.length;
  return dishes.filter((d) => {
    if (filter === 'vegan') return d.classification === 'vegan';
    if (filter === 'vegetarian') return d.classification === 'vegan' || d.classification === 'vegetarian';
    return false;
  }).length;
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
  // restaurant has multiple analysed menus.
  const [menuFilter, setMenuFilter] = useState<string>('all');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { setRestaurantName } = useHeader();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    fetch(`/api/restaurants/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error('Restaurant not found');
        return r.json();
      })
      .then((data: Restaurant) => {
        setRestaurant(data);
        const labels = distinctMenuLabels(data);
        if (labels.length > 1) setMenuFilter((prev) => (prev === 'all' ? labels[0] : prev));
        if (data.name) {
          setRestaurantName(data.name);
          document.title = `${data.name} | Picky`;
        }
        setLoading(false);

        // While the AI is still working, keep checking without asking the
        // user to refresh manually — DB reads only, no extra AI cost.
        if (data.status === 'pending' || data.status === 'processing') {
          pollTimer.current = setTimeout(load, PENDING_POLL_MS);
        }
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [params.id, setRestaurantName]);

  useEffect(() => {
    load();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      setRestaurantName(null);
      document.title = 'Picky — Find your food, your way';
    };
  }, [load, setRestaurantName]);

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
        <h1 className="text-xl font-bold text-evergreen mb-2">Restaurant not found</h1>
        <p className="text-evergreen/80 mb-6">{error ?? "This restaurant doesn't exist or was removed."}</p>
        <Link href="/" className="btn-primary text-sm">
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
        : {
            heading: 'No menu listed on this site',
            body: `We looked, but ${name}'s website doesn't seem to publish a menu online.`,
          };
    return (
      <div className="max-w-lg mx-auto px-4 py-16">
        <div className="text-center mb-6">
          <LeafOutlineIcon className="w-12 h-12 mx-auto mb-4 text-picky-500" />
          <h1 className="text-xl font-bold text-evergreen mb-2">{copy.heading}</h1>
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
        <h1 className="text-xl font-bold text-evergreen mb-2">Couldn&apos;t read this menu</h1>
        <p className="text-evergreen/80 mb-2">
          {restaurant.errorMessage ?? 'An error occurred while parsing this restaurant.'}
        </p>
        <p className="text-sm text-evergreen/80 mb-6">
          The menu may be temporarily unavailable, or this website may require JavaScript to load.
        </p>
        <Link href="/" className="btn-primary text-sm">
          ← Try a different link
        </Link>
      </div>
    );
  }

  if (restaurant.status === 'pending' || restaurant.status === 'processing') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <SproutIcon className="w-12 h-12 mx-auto mb-4 text-picky-500 animate-pulse-gentle" />
        <h1 className="text-xl font-bold text-evergreen mb-2">
          Our AI is reading {restaurant.name ?? 'this menu'}&hellip;
        </h1>
        <p className="text-evergreen/80 mb-6">
          Usually under a minute — this page updates itself the moment it&apos;s ready.
        </p>
        <Link href="/dublin" className="btn-primary text-sm">
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

  const veganCount = countDishes(visibleSections, 'vegan');
  const vegCount = countDishes(visibleSections, 'vegetarian');
  const totalDishes = visibleSections.flatMap((s) => s.dishes).length;

  const filters: { value: Filter; label: string; count: number }[] = [
    { value: 'all', label: '🍽️ Everything', count: totalDishes },
    { value: 'vegetarian', label: '🍳 Veggie', count: vegCount },
    { value: 'vegan', label: '🌱 Vegan', count: veganCount },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Back */}
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-evergreen/80 hover:text-evergreen mb-6">
        ← Back to search
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-evergreen">
            {restaurant.name ?? 'Restaurant Menu'}
          </h1>
          <div className="shrink-0 pt-0.5 flex items-center gap-2">
            <button
              onClick={() => { setFeedbackOpen(true); capture('feedback_modal_opened', { restaurant_id: restaurant.id }); }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border-2 border-mint-200 text-sm text-evergreen/80 hover:border-picky-300 hover:text-evergreen transition-colors"
            >
              <ChatIcon className="w-4 h-4" />
              Feedback
            </button>
            <ShareButton restaurant={restaurant} />
          </div>
        </div>
        {restaurant.cuisine && (
          <p className="text-xs font-mono uppercase tracking-[0.08em] text-evergreen/50 mt-1">{restaurant.cuisine}</p>
        )}
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
          <FreshnessIndicator
            lastScrapedAt={restaurant.lastScrapedAt}
            restaurantId={restaurant.id}
          />
          <FlagOutdatedButton restaurantId={restaurant.id} restaurantName={restaurant.name ?? null} />
        </div>
      </div>

      {/* Second-pass AI audit ribbon */}
      <div className="flex items-center gap-3 rounded-2xl bg-mint-100 text-picky-700 px-4 py-3 mb-6 text-sm">
        <ShieldIcon className="w-4 h-4 flex-shrink-0" />
        <span>
          Second-pass AI verification: fish sauce, gelatine and hidden stock get caught before this page reaches you.
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="card p-3 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🌱</div>
          <div className="text-2xl font-bold bg-solar-gradient bg-clip-text text-transparent">{veganCount}</div>
          <div className="text-xs text-evergreen/80 mt-0.5">Vegan</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🍳</div>
          <div className="text-2xl font-bold text-picky-600">{vegCount}</div>
          <div className="text-xs text-evergreen/80 mt-0.5">Veggie</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-lg mb-0.5" aria-hidden="true">🍽️</div>
          <div className="text-2xl font-bold text-evergreen/80">{totalDishes}</div>
          <div className="text-xs text-evergreen/80 mt-0.5">Dishes read</div>
        </div>
      </div>

      {/* Menu selector — only when multiple menus were analysed */}
      {menuLabels.length > 1 && (
        <div className="mb-4">
          <label htmlFor="menu-select" className="block text-xs font-medium text-evergreen/80 mb-1.5">
            Menu
          </label>
          <select
            id="menu-select"
            value={menuFilter}
            onChange={(e) => { setMenuFilter(e.target.value); capture('menu_filter_changed', { menu_label: e.target.value, restaurant_id: params.id }); }}
            className="w-full sm:w-auto px-4 py-2 rounded-full border-2 border-mint-200 bg-white text-sm font-medium text-evergreen focus:outline-none focus:ring-4 focus:ring-picky-500/15 focus:border-picky-500"
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

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => { setFilter(f.value); capture('filter_changed', { filter: f.value, restaurant_id: params.id }); }}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors duration-150 border-2 ${
              filter === f.value
                ? 'bg-evergreen border-evergreen text-white'
                : 'bg-white border-mint-200 text-evergreen/80 hover:border-picky-300'
            }`}
          >
            {f.label}
            <span className={`ml-1.5 text-xs ${filter === f.value ? 'text-lime' : 'text-evergreen/80'}`}>
              {f.count}
            </span>
          </button>
        ))}
      </div>

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
                <h2 className="text-lg font-bold text-evergreen mb-3 pb-2 border-b-[1.5px] border-mint-200">{label}</h2>
                {group.map((section) => (
                  <MenuSection key={section.id} section={section} activeFilter={filter} />
                ))}
              </div>
            );
          })}
          {visibleSections
            .filter((s) => !s.menuLabel)
            .map((section) => (
              <MenuSection key={section.id} section={section} activeFilter={filter} />
            ))}
        </>
      ) : (
        <>
          {visibleSections.map((section) => (
            <MenuSection key={section.id} section={section} activeFilter={filter} />
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
        />
      )}
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
