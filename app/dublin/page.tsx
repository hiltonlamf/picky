import type { Metadata } from 'next';
import { getFeaturedRestaurants } from '@/lib/db';
import RestaurantCard from '@/components/RestaurantCard';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Vegetarian & Vegan Restaurants in Dublin',
  description:
    'Discover vegetarian and vegan-friendly restaurants in Dublin, Ireland. Browse dish-level dietary information for the best plant-based eating in the city.',
};

const DUBLIN_RESTAURANTS = [
  'Assassination Custard',
  'Chez Max',
  'Chubbys',
  'Dimmi by Dunne & Crescenzi',
  'King Sitric Seafood Bar & Accommodation',
  'Forêt',
  'La Vespa',
  'Mermaid Monkstown',
  'Osteria Lucio',
  'Vada',
];

export const revalidate = 3600;

export default async function DublinPage() {
  let restaurants: Awaited<ReturnType<typeof getFeaturedRestaurants>> = [];
  try {
    restaurants = await getFeaturedRestaurants('dublin');
  } catch {
    // DB may not be configured yet — show placeholder
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="mb-10 text-center sm:text-left">
        <div className="inline-flex items-center gap-2 bg-picky-50 text-picky-700 text-sm font-medium px-4 py-1.5 rounded-full mb-4 border border-picky-100">
          <span>🇮🇪</span>
          <span>Dublin, Ireland</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          Vegetarian &amp; Vegan Restaurants in Dublin
        </h1>
        <p className="text-gray-500 max-w-2xl sm:text-lg">
          We&apos;ve analysed the menus at these Dublin restaurants so you can see exactly which
          dishes are vegetarian or vegan before you visit.
        </p>
      </div>

      {/* Featured restaurants grid */}
      {restaurants.length > 0 ? (
        <div className="grid sm:grid-cols-2 gap-4 mb-12">
          {restaurants.map((r) => (
            <RestaurantCard key={r.id} restaurant={r} />
          ))}
        </div>
      ) : (
        /* Placeholder when DB isn't seeded yet */
        <div className="mb-12">
          <div className="card p-6 border-amber-200 bg-amber-50 mb-6">
            <p className="text-sm text-amber-800 font-medium mb-1">
              🌱 Dublin guide coming soon
            </p>
            <p className="text-sm text-amber-700">
              We&apos;re currently building our Dublin restaurant database. In the meantime, you can
              search any restaurant directly using the home page.
            </p>
          </div>

          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            Featured restaurants (loading...)
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {DUBLIN_RESTAURANTS.map((name) => (
              <div key={name} className="card p-5 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-3" />
                <div className="h-3 bg-gray-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search CTA */}
      <div className="card p-6 sm:p-8 bg-gradient-to-br from-picky-50 to-white border-picky-100">
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          Don&apos;t see your restaurant?
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          Paste any restaurant link and Picky will analyse the menu for you instantly.
        </p>
        <Link href="/" className="btn-primary text-sm">
          Search a restaurant →
        </Link>
      </div>

      {/* SEO content */}
      <section className="mt-12 prose prose-sm max-w-none text-gray-600">
        <h2 className="text-lg font-semibold text-gray-800 not-prose mb-3">
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
