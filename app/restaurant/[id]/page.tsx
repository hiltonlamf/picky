'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { Restaurant, DietaryClassification, MenuSection as MenuSectionType } from '@/types';
import MenuSection from '@/components/MenuSection';
import FreshnessIndicator from '@/components/FreshnessIndicator';
import Disclaimer from '@/components/Disclaimer';
import ShareButton from '@/components/ShareButton';
import { useHeader } from '@/lib/header-context';

type Filter = 'all' | 'vegan' | 'vegetarian';

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
  const { setRestaurantName } = useHeader();

  useEffect(() => {
    fetch(`/api/restaurants/${params.id}`)
      .then((r) => {
        if (!r.ok) throw new Error('Restaurant not found');
        return r.json();
      })
      .then((data: Restaurant) => {
        setRestaurant(data);
        // Default to viewing one menu at a time — a combined lunch+dinner+... list isn't helpful.
        const labels = distinctMenuLabels(data);
        if (labels.length > 1) setMenuFilter(labels[0]);
        if (data.name) {
          setRestaurantName(data.name);
          document.title = `${data.name} | Picky`;
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });

    return () => {
      setRestaurantName(null);
      document.title = 'Picky — Find your food, your way';
    };
  }, [params.id, setRestaurantName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse-gentle">🥦</div>
          <p className="text-gray-500 text-sm">Loading menu...</p>
        </div>
      </div>
    );
  }

  if (error || !restaurant) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">😕</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Restaurant not found</h1>
        <p className="text-gray-500 mb-6">{error ?? 'This restaurant doesn\'t exist or was removed.'}</p>
        <Link href="/" className="btn-primary text-sm">
          ← Back to search
        </Link>
      </div>
    );
  }

  if (restaurant.status === 'error') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="text-5xl mb-4">⚠️</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn&apos;t analyse this menu</h1>
        <p className="text-gray-500 mb-2">
          {restaurant.errorMessage ?? 'An error occurred while parsing this restaurant.'}
        </p>
        <p className="text-sm text-gray-400 mb-6">
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
        <div className="text-5xl mb-4 animate-pulse">🌱</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Analysing {restaurant.name ?? 'this menu'}&hellip;
        </h1>
        <p className="text-gray-500 mb-6">
          Our AI is reading and classifying the menu right now. This usually takes under a minute.
          Refresh the page to see results.
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
    { value: 'all', label: 'All dishes', count: totalDishes },
    { value: 'vegetarian', label: '🍳 Vegetarian', count: vegCount },
    { value: 'vegan', label: '🥦 Vegan', count: veganCount },
  ];

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Back */}
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6">
        ← Back to search
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-gray-900">
            {restaurant.name ?? 'Restaurant Menu'}
          </h1>
          <div className="shrink-0 pt-0.5">
            <ShareButton restaurant={restaurant} />
          </div>
        </div>
        {restaurant.menuUrl && (
          <a
            href={restaurant.menuUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-picky-600 hover:underline mt-1 inline-block"
          >
            View original menu ↗
          </a>
        )}
        <div className="mt-3">
          <FreshnessIndicator
            lastScrapedAt={restaurant.lastScrapedAt}
            restaurantId={restaurant.id}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Vegan', count: veganCount, emoji: '🥦', color: 'text-picky-700' },
          { label: 'Vegetarian', count: vegCount, emoji: '🍳', color: 'text-picky-600' },
          { label: 'Total dishes', count: totalDishes, emoji: '🥩', color: 'text-gray-600' },
        ].map((stat) => (
          <div key={stat.label} className="card p-3 text-center">
            <div className="text-xl mb-0.5">{stat.emoji}</div>
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.count}</div>
            <div className="text-xs text-gray-500 mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Menu selector — only when multiple menus were analysed */}
      {menuLabels.length > 1 && (
        <div className="mb-4">
          <label htmlFor="menu-select" className="block text-xs font-medium text-gray-500 mb-1.5">
            Menu
          </label>
          <select
            id="menu-select"
            value={menuFilter}
            onChange={(e) => setMenuFilter(e.target.value)}
            className="w-full sm:w-auto px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-picky-500"
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
            onClick={() => setFilter(f.value)}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors duration-150 ${
              filter === f.value
                ? 'bg-picky-600 text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-picky-300'
            }`}
          >
            {f.label}
            <span
              className={`ml-1.5 text-xs ${
                filter === f.value ? 'text-picky-100' : 'text-gray-400'
              }`}
            >
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {/* Menu sections */}
      {visibleSections.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-4xl mb-3">🤔</div>
          <p className="text-gray-600">No menu sections found for this restaurant.</p>
        </div>
      ) : menuLabels.length > 1 && menuFilter === 'all' ? (
        // "All menus" view: group sections under a heading per source menu.
        <>
          {menuLabels.map((label) => {
            const group = visibleSections.filter((s) => s.menuLabel === label);
            if (group.length === 0) return null;
            return (
              <div key={label} className="mb-8">
                <h2 className="text-lg font-bold text-gray-900 mb-3 pb-2 border-b border-gray-200">{label}</h2>
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
    </div>
  );
}
