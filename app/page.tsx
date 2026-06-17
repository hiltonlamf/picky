import type { Metadata } from 'next';
import HeroSearch from '@/components/HeroSearch';

export const metadata: Metadata = {
  title: 'Picky — Find your food, your way',
  description:
    'Type a restaurant name or paste any link. Picky reads the menu and tells you exactly which dishes are vegetarian or vegan.',
};

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="px-4 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-picky-50 text-picky-700 text-sm font-medium px-4 py-1.5 rounded-full mb-6 border border-picky-100">
            <span>🌱</span>
            <span>Now live in Dublin, Ireland</span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight mb-4">
            Find what you can eat.{' '}
            <span className="text-picky-600">Instantly.</span>
          </h1>

          <p className="text-lg text-gray-500 mb-8 max-w-lg mx-auto">
            Type a restaurant name or paste any link. Picky reads the menu and tells you exactly
            which dishes are vegetarian or vegan — including hidden ingredients AI might miss.
          </p>

          <div className="flex justify-center">
            <HeroSearch />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="px-4 py-12 bg-white border-y border-gray-100">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-xl font-bold text-gray-900 text-center mb-8">How Picky works</h2>
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              {
                emoji: '🔗',
                title: 'Paste any link',
                desc: 'Type a restaurant name or paste any link — website, menu page, or PDF. Picky figures out the rest.',
              },
              {
                emoji: '🤖',
                title: 'AI reads the menu',
                desc: 'Picky navigates to the menu and analyses every dish, flagging hidden non-veg ingredients.',
              },
              {
                emoji: '🥦',
                title: 'See what you can eat',
                desc: 'Results grouped by section with dietary labels and confidence scores per dish.',
              },
            ].map((item) => (
              <div key={item.title} className="card p-5 text-center">
                <div className="text-3xl mb-3">{item.emoji}</div>
                <h3 className="font-semibold text-gray-900 mb-2">{item.title}</h3>
                <p className="text-sm text-gray-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Dublin CTA */}
      <section className="px-4 py-12">
        <div className="max-w-3xl mx-auto">
          <div className="card p-6 sm:p-8 bg-gradient-to-br from-picky-50 to-white border-picky-100">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">
                  Eating out in Dublin? 🇮🇪
                </h2>
                <p className="text-sm text-gray-600">
                  Browse our pre-analysed guide to vegetarian-friendly Dublin restaurants.
                </p>
              </div>
              <a
                href="/dublin"
                className="btn-primary flex-shrink-0 text-sm"
              >
                View Dublin Guide →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Trust signals */}
      <section className="px-4 py-8 border-t border-gray-100 bg-white">
        <div className="max-w-3xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            {[
              { label: 'Confidence scores', sub: 'on every dish' },
              { label: 'Multi-language', sub: 'French, Italian, German +' },
              { label: 'Cached results', sub: 'instant repeat visits' },
              { label: 'User reports', sub: 'community-verified' },
            ].map((item) => (
              <div key={item.label} className="p-3">
                <p className="text-sm font-semibold text-gray-800">{item.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
