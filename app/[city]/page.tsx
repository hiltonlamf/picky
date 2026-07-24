import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getFeaturedRestaurants, getCityGuideBySlug } from '@/lib/db';
import RestaurantCard from '@/components/RestaurantCard';
import { isPubliclyVisible, computeReviewFlags, countDishes, MIN_GUIDE_DISHES } from '@/lib/review-flags';
import { SproutIcon } from '@/components/icons';
import GuideFeedbackButton from '@/components/GuideFeedbackButton';
import { ADMIN_COOKIE_NAME, expectedAdminCookieValue } from '@/lib/admin-auth';
import type { Restaurant } from '@/types';

// Reads the DB per request and must reflect the latest edits/publish state, so
// it can never be statically prerendered (CI has no DB) or cached.
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/** Whether the current viewer is a signed-in admin (so a draft guide can be
 *  previewed). Mirrors the middleware's cookie check; fails closed. */
async function isAdminViewer(): Promise<boolean> {
  const expected = await expectedAdminCookieValue();
  if (!expected) return false;
  return cookies().get(ADMIN_COOKIE_NAME)?.value === expected;
}

export async function generateMetadata({ params }: { params: { city: string } }): Promise<Metadata> {
  const guide = await getCityGuideBySlug(params.city).catch(() => null);
  // Draft (or unknown) guides must not be indexable / discoverable.
  if (!guide || guide.status !== 'published') {
    return { robots: { index: false, follow: false } };
  }
  const where = guide.country ? `${guide.displayName}, ${guide.country}` : guide.displayName;
  return {
    title: `Vegetarian & Vegan Restaurants in ${guide.displayName}`,
    description: `Discover vegetarian and vegan-friendly restaurants in ${where}. Browse dish-level dietary information for the best plant-based eating in the city.`,
  };
}

/** One-line reason a featured restaurant is being withheld from the public. */
function heldBackReason(r: Restaurant): string {
  if (r.status === 'error') return 'analysis errored';
  if (r.status === 'no_menu') return 'no menu found';
  if (r.status !== 'done') return r.status;
  const dishes = countDishes(r);
  if (dishes < MIN_GUIDE_DISHES) return `only ${dishes} dish${dishes === 1 ? '' : 'es'}`;
  const flags = computeReviewFlags(r);
  if (flags.length) return flags[0].detail;
  return 'held back for review';
}

export default async function CityGuidePage({ params }: { params: { city: string } }) {
  const slug = params.city;
  const guide = await getCityGuideBySlug(slug).catch(() => null);
  if (!guide) notFound();

  const isAdmin = await isAdminViewer();
  const isDraft = guide.status !== 'published';
  // A draft guide is invisible to the public — only an admin may preview it.
  if (isDraft && !isAdmin) notFound();

  // Preview mode: an admin viewing a not-yet-live guide. "What you preview is
  // what publishes" — same public render, plus a banner listing held-back ones.
  const previewMode = isDraft && isAdmin;

  let restaurants: Restaurant[] = [];
  try {
    // Excludes manually-hidden restaurants — exactly what the public will see.
    restaurants = await getFeaturedRestaurants(slug);
  } catch {
    // DB may be unavailable — fall through to the empty/initialising state.
  }

  const visibleRestaurants = restaurants.filter(isPubliclyVisible);
  const pendingRestaurants = restaurants.filter((r) => r.status === 'pending' || r.status === 'processing');
  const heldBack = restaurants.filter(
    (r) => !isPubliclyVisible(r) && r.status !== 'pending' && r.status !== 'processing'
  );
  const isInitialising = restaurants.length === 0 || pendingRestaurants.length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Admin preview banner — only shown to an admin previewing a draft. */}
      {previewMode && (
        <div className="card p-5 mb-6 border-2 border-amber-400 bg-amber-50">
          <p className="text-sm font-semibold text-amber-900 mb-1 font-mono tracking-[0.08em] uppercase">
            Preview — not yet live
          </p>
          <p className="text-sm text-amber-900/90">
            This is exactly how the public guide will look once you publish it:{' '}
            <strong>{visibleRestaurants.length}</strong> restaurant
            {visibleRestaurants.length === 1 ? '' : 's'} will go live
            {heldBack.length > 0 ? `, ${heldBack.length} held back.` : '.'}
          </p>
          {heldBack.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-amber-900/90">
              {heldBack.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{r.name ?? 'Restaurant'}</span>
                  <span className="text-amber-800/80">— {heldBackReason(r)}</span>
                  <Link
                    href={`/admin/restaurants/${r.id}/review`}
                    className="underline text-amber-900 hover:text-amber-700"
                  >
                    review →
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href={`/admin/guides/${slug}`} className="inline-block mt-3 text-sm font-medium text-amber-900 underline">
            ← Back to guide workspace
          </Link>
        </div>
      )}

      {/* Header */}
      <div className="mb-10 text-center sm:text-left">
        <div className="inline-flex items-center gap-2 bg-evergreen text-lime text-xs font-medium px-4 py-1.5 rounded-full mb-4 font-mono tracking-[0.12em] uppercase">
          <span className="live-dot" />
          <span>{guide.country ? `${guide.displayName}, ${guide.country}` : guide.displayName}</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-evergreen mb-3 tracking-tight">
          {guide.tagline ?? `${guide.displayName}, pre-scouted by AI`}
        </h1>
        <p className="text-evergreen/80 max-w-2xl sm:text-lg mb-5">
          Our AI has already read and verified the menus at these {guide.displayName} restaurants, so you can
          see exactly which dishes are veggie or vegan before you visit.
        </p>
        <GuideFeedbackButton city={slug} />
      </div>

      {/* Initialising banner */}
      {isInitialising && (
        <div className="card p-5 mb-6 flex items-start gap-3">
          <SproutIcon className="w-5 h-5 text-picky-600 mt-0.5 animate-pulse-gentle flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-evergreen mb-0.5">
              Our AI is scouting {guide.displayName} menus&hellip;
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

      {/* Empty state when nothing is live yet */}
      {visibleRestaurants.length === 0 && pendingRestaurants.length === 0 && (
        <div className="card p-6 mb-6 text-center text-evergreen/70">
          No restaurants are live in this guide yet.
        </div>
      )}

      {/* Search CTA */}
      <div className="relative overflow-hidden rounded-3xl bg-evergreen p-6 sm:p-8">
        <div
          className="pointer-events-none absolute -right-10 -top-10 w-44 h-44 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(198,245,66,0.25), transparent 70%)' }}
        />
        <div className="relative">
          <h2 className="text-xl font-bold text-lime mb-2">Don&apos;t see your restaurant?</h2>
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
          About vegetarian dining in {guide.displayName}
        </h2>
        <p>
          Picky helps you find the best vegetarian and vegan options in {guide.displayName} without having to
          ring ahead or scan through menus yourself. Our AI reads every dish on the menu and flags which are
          vegetarian or vegan — including checking for hidden non-vegetarian ingredients like fish sauce, beef
          stock, and anchovies that often appear in otherwise plant-friendly dishes.
        </p>
      </section>
    </div>
  );
}
