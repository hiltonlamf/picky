import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getFeaturedRestaurants, getCityGuideBySlug } from '@/lib/db';
import GuideRestaurantGrid from '@/components/GuideRestaurantGrid';
import { isPubliclyVisible, computeReviewFlags, countDishes, MIN_GUIDE_DISHES } from '@/lib/review-flags';
import GuideFeedbackButton from '@/components/GuideFeedbackButton';
import CountingMethod from '@/components/CountingMethod';
import GuideViewTracker from '@/components/GuideViewTracker';
import { ADMIN_COOKIE_NAME, expectedAdminCookieValue } from '@/lib/admin-auth';
import { GUIDE_HUMAN_LINE, countryFlag, guideHeadline, guideIntro, guideMetaDescription } from '@/lib/site-copy';
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
    title: `Vegetarian & Vegan Options in ${guide.displayName}’s Most Popular Restaurants`,
    description: guideMetaDescription(guide.displayName, where),
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
  const where = guide.country ? `${guide.displayName}, ${guide.country}` : guide.displayName;
  const flag = countryFlag(guide.country);

  return (
    <div className="bg-paper">
      {/* Admin preview banner — only shown to an admin previewing a draft. */}
      {previewMode && (
        <div className="card p-5 m-4 border-2 border-amber-400 bg-amber-50">
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

      {/* Header band — forest with the mesh field, same as the homepage hero.
          This was Dublin's own design while it had a separate route; it is now
          every city's, so the guides can't drift apart again. */}
      <section className="relative overflow-hidden bg-forest-deep text-paper pt-14 pb-16">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[66%] h-[86%] left-[-12%] top-[-16%] bg-[#0f7a52] opacity-55" />
          <span className="w-[54%] h-[74%] left-[44%] top-[14%] bg-[#14563c] opacity-75" />
          <span className="w-[32%] h-[46%] left-[68%] top-[-12%] bg-azalea-500 opacity-[0.28]" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner">
          <span className="glass inline-flex items-center gap-2.5 rounded-full px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase text-paper/90">
            <span className="w-1.5 h-1.5 rounded-full bg-azalea-500 animate-blink" />
            {where}
          </span>
          <h1 className="font-display text-[clamp(2rem,4.6vw,3.1rem)] leading-[1.04] tracking-[-0.025em] mt-5 mb-4 max-w-[20ch] text-balance">
            {flag && (
              <span className="mr-2" role="img" aria-label={guide.country ?? ''}>
                {flag}
              </span>
            )}
            {guide.tagline ?? guideHeadline(guide.displayName)}
          </h1>
          <p className="text-paper/90 max-w-[62ch] text-[1.02rem] leading-relaxed">
            {guideIntro(guide.displayName)}
          </p>
          <p className="text-paper/70 max-w-[62ch] text-sm mt-3">{GUIDE_HUMAN_LINE}</p>
          <CountingMethod surface="guide" tone="dark" className="mt-3" />
          <div className="mt-6">
            <GuideFeedbackButton city={slug} tone="dark" />
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 py-12">
      <GuideViewTracker city={slug} restaurantCount={visibleRestaurants.length} />

      {/* Featured restaurants grid — publicly-visible ones only */}
      {visibleRestaurants.length > 0 && (
        <GuideRestaurantGrid restaurants={visibleRestaurants} />
      )}

      {/* Pending / processing skeleton cards */}
      {pendingRestaurants.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          {pendingRestaurants.map((r) => (
            <div key={r.id} className="rounded-[20px] border-2 border-forest/25 p-5 bg-white/60">
              <p className="font-display text-forest/70 mb-1 truncate">{r.name ?? 'Restaurant'}</p>
              <p className="text-xs text-azalea-700 animate-pulse-gentle font-mono">Reading the menu&hellip;</p>
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
      <div className="relative overflow-hidden rounded-3xl bg-forest text-paper p-7 sm:p-9">
        <div className="mesh" aria-hidden="true">
          <span className="w-[52%] h-[90%] left-[58%] top-[-22%] bg-azalea-500 opacity-30" />
          <span className="w-[50%] h-[80%] left-[-8%] top-[16%] bg-[#0f7a52] opacity-50" />
        </div>
        <div className="relative z-[2]">
          <h2 className="font-display text-2xl mb-2">Don&apos;t see your restaurant?</h2>
          <p className="text-sm text-paper/85 mb-5 max-w-[46ch]">
            Paste any restaurant link and we&apos;ll read the menu for you, dish by dish.
          </p>
          {/* ?search=1 opens the homepage hero's search panel straight away —
              the guide is now the homepage's primary CTA, so a bare "/" would
              land people on a page where the box this button promises is
              hidden behind another click. */}
          <Link href="/?search=1" className="btn-cta inline-block">
            🥦 Find my veggies →
          </Link>
        </div>
      </div>

      {/* SEO content */}
      <section className="mt-12 max-w-3xl text-forest/80 text-[0.95rem] leading-relaxed space-y-4">
        <h2 className="font-display text-xl text-forest">
          About vegetarian dining in {guide.displayName}
        </h2>
        <p>
          Platefully helps you find which of {guide.displayName}&apos;s most popular restaurants are actually
          good for vegetarians, without ringing ahead or scanning menus yourself. The AI reads every dish
          and flags which are vegetarian or vegan — including hidden non-vegetarian ingredients like fish
          sauce, beef stock and anchovies that often appear in otherwise plant-friendly dishes. We sample
          and review those results by hand before they go live.
        </p>
      </section>
      </div>
    </div>
  );
}
