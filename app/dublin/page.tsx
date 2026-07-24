import type { Metadata } from 'next';
import { getFeaturedRestaurants } from '@/lib/db';
import RestaurantCard from '@/components/RestaurantCard';
import Link from 'next/link';
import { DUBLIN_RESTAURANTS as DUBLIN_LIST } from '@/lib/init-dublin';
import { isPubliclyVisible } from '@/lib/review-flags';
import { HarpIcon, SproutIcon } from '@/components/icons';
import GuideFeedbackButton from '@/components/GuideFeedbackButton';
import { GUIDE_HUMAN_LINE, guideHeadline, guideIntro, guideMetaDescription } from '@/lib/site-copy';

export const metadata: Metadata = {
  title: 'Vegetarian & Vegan Options in Dublin’s Most Popular Restaurants',
  description: guideMetaDescription('Dublin', 'Dublin'),
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
    <div className="bg-paper">
      {/* Header band — forest with the mesh field, same as the homepage hero */}
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
            Dublin, Ireland
          </span>
          <h1 className="font-display text-[clamp(2rem,4.6vw,3.1rem)] leading-[1.04] tracking-[-0.025em] mt-5 mb-4 max-w-[20ch] text-balance">
            <HarpIcon className="inline-block w-9 h-9 align-[-0.16em] mr-2" />
            {guideHeadline('Dublin')}
          </h1>
          <p className="text-paper/90 max-w-[62ch] text-[1.02rem] leading-relaxed">
            {guideIntro('Dublin')}
          </p>
          <p className="text-paper/70 max-w-[62ch] text-sm mt-3">{GUIDE_HUMAN_LINE}</p>
          <div className="mt-6">
            <GuideFeedbackButton city="dublin" tone="dark" />
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Initialising banner */}
        {isInitialising && (
          <div className="card p-5 mb-6 flex items-start gap-3">
            <SproutIcon className="w-5 h-5 text-picky-600 mt-0.5 animate-pulse-gentle flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-evergreen mb-0.5">
                Reading the Dublin menus&hellip;
              </p>
              <p className="text-sm text-evergreen/80">
                This page updates itself automatically as each restaurant finishes.
              </p>
            </div>
          </div>
        )}

        {/* Featured restaurants grid — publicly-visible ones only */}
        {visibleRestaurants.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-4 mb-8">
            {visibleRestaurants.map((r) => (
              <RestaurantCard key={r.id} restaurant={r} />
            ))}
          </div>
        )}

        {/* Pending / processing skeleton cards */}
        {pendingRestaurants.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-4 mb-8">
            {pendingRestaurants.map((r) => (
              <div key={r.id} className="rounded-[20px] border-2 border-forest/25 p-5 bg-white/60">
                <p className="font-display text-forest/70 mb-1 truncate">{r.name ?? 'Restaurant'}</p>
                <p className="text-xs text-azalea-700 animate-pulse-gentle font-mono">Reading the menu&hellip;</p>
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
            <Link href="/" className="btn-cta inline-block">
              🥦 Find my veggies →
            </Link>
          </div>
        </div>

        {/* SEO content */}
        <section className="mt-12 max-w-3xl text-forest/80 text-[0.95rem] leading-relaxed space-y-4">
          <h2 className="font-display text-xl text-forest">About vegetarian dining in Dublin</h2>
          <p>
            Dublin&apos;s restaurant scene has grown considerably more plant-friendly in recent years, but
            the hard part isn&apos;t finding a vegetarian restaurant — it&apos;s working out which of the
            places everyone actually wants to book have something worth ordering for the vegetarian at
            the table. That is what this guide is for.
          </p>
          <p>
            The AI reads every dish on the menu and flags which are vegetarian or vegan — including
            checking for hidden non-vegetarian ingredients like fish sauce, beef stock and anchovies
            that often appear in otherwise plant-friendly dishes. We then sample and review those
            results by hand before they go live, and keep working through our own error log to improve
            them.
          </p>
        </section>
      </div>
    </div>
  );
}
