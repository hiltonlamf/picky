import type { Metadata } from 'next';
import { getFeaturedRestaurants } from '@/lib/db';
import RestaurantCard from '@/components/RestaurantCard';
import Link from 'next/link';
import { DUBLIN_RESTAURANTS as DUBLIN_LIST } from '@/lib/init-dublin';
import { isPubliclyVisible } from '@/lib/review-flags';
import { SproutIcon } from '@/components/icons';

export const metadata: Metadata = {
  title: 'Vegetarian & Vegan Restaurants in Dublin',
  description:
    'Discover vegetarian and vegan-friendly restaurants in Dublin, Ireland. Browse dish-level dietary information for the best plant-based eating in the city.',
};

// Revalidate every 5 minutes while restaurants are being initialised;
// once all are done the page content stabilises naturally.
export const revalidate = 300;

export default async function DublinPage() {
  let restaurants: Awaited<ReturnType<typeof getFeaturedRestaurants>> = [];
  try {
    restaurants = await getFeaturedRestaurants('dublin');
  } catch {
    // DB may not be configured yet — show placeholder
  }

  // Only show restaurants that are safe to publish: a completed analysis with
  // enough real dishes and no unreviewed "looks odd" flag (e.g. a tasting menu
  // captured as a single dish). Errored / thin / flagged restaurants are
  // withheld — the admin eval dashboard surfaces them for review instead.
  const visibleRestaurants = restaurants.filter(isPubliclyVisible);
  const pendingRestaurants = restaurants.filter((r) => r.status === 'pending' || r.status === 'processing');

  const isInitialising = restaurants.length === 0 || pendingRestaurants.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="mb-10 text-center sm:text-left">
        <div className="inline-flex items-center gap-2 bg-evergreen text-lime text-xs font-medium px-4 py-1.5 rounded-full mb-4 font-mono tracking-[0.12em] uppercase">
          <span className="live-dot" />
          <span>Dublin, Ireland</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-evergreen mb-3 tracking-tight">
          Dublin, pre-scouted by AI
        </h1>
        <p className="text-evergreen/80 max-w-2xl sm:text-lg">
          Our AI has already read and verified the menus at these Dublin restaurants, so you can
          see exactly which dishes are veggie or vegan before you visit.
        </p>
      </div>

      {/* Initialising banner */}
      {isInitialising && (
        <div className="card p-5 mb-6 flex items-start gap-3">
          <SproutIcon className="w-5 h-5 text-picky-600 mt-0.5 animate-pulse-gentle flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-evergreen mb-0.5">
              Our AI is scouting Dublin menus&hellip;
            </p>
            <p className="text-sm text-evergreen/80">
              This page updates itself automatically as each restaurant finishes.
            </p>
          </div>
        </div>
      )}

      {/* Featured restaurants grid — publicly-visible ones only */}
      {visibleRestaurants.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          {visibleRestaurants.map((r) => (
            <RestaurantCard key={r.id} restaurant={r} />
          ))}
        </div>
      )}

      {/* Pending / processing skeleton cards */}
      {pendingRestaurants.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          {pendingRestaurants.map((r) => (
            <div key={r.id} className="card p-5 bg-mint-50">
              <p className="font-semibold text-evergreen/80 mb-1 truncate">{r.name ?? 'Restaurant'}</p>
              <p className="text-xs text-picky-600 animate-pulse-gentle">AI reading the menu&hellip;</p>
            </div>
          ))}
        </div>
      )}

      {/* Placeholder when DB isn't seeded yet */}
      {restaurants.length === 0 && (
        <div className="mb-12">
          <div className="grid sm:grid-cols-2 gap-4">
            {DUBLIN_LIST.map(({ name }) => (
              <div key={name} className="card p-5 animate-pulse-gentle">
                <div className="h-4 bg-mint-200 rounded w-3/4 mb-3" />
                <div className="h-3 bg-mint-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search CTA */}
      <div className="relative overflow-hidden rounded-3xl bg-evergreen p-6 sm:p-8">
        <div
          className="pointer-events-none absolute -right-10 -top-10 w-44 h-44 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(198,245,66,0.25), transparent 70%)' }}
        />
        <div className="relative">
          <h2 className="text-xl font-bold text-lime mb-2">
            Don&apos;t see your restaurant?
          </h2>
          <p className="text-sm text-mint-100 mb-4">
            Drop any restaurant link and our AI will read the menu for you, instantly.
          </p>
          <Link href="/" className="btn-primary text-sm">
            Search a restaurant →
          </Link>
        </div>
      </div>

      {/* SEO content */}
      <section className="mt-12 prose prose-sm max-w-none text-evergreen/80">
        <h2 className="text-lg font-semibold text-evergreen not-prose mb-3">
          About vegetarian dining in Dublin
        </h2>
        <p>
          Dublin&apos;s restaurant scene has grown considerably more plant-friendly in recent years.
          From dedicated vegan cafés in the city centre to traditional restaurants with strong
          vegetarian menus, there&apos;s more choice than ever. Picky helps you find the best
          options without having to ring ahead or scan through menus yourself.
        </p>
        <p>
          Our AI reads every dish on the menu and flags which are vegetarian or vegan — including
          checking for hidden non-vegetarian ingredients like fish sauce, beef stock, and anchovies
          that often appear in otherwise plant-friendly dishes.
        </p>
      </section>
    </div>
  );
}
