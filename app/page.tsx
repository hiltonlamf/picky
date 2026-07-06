import type { Metadata } from 'next';
import HeroSearch from '@/components/HeroSearch';
import { LinkIcon, ScanIcon, ShieldIcon } from '@/components/icons';

export const metadata: Metadata = {
  title: 'Picky — Find your food, your way',
  description:
    'Paste any restaurant link and instantly discover which dishes are vegetarian or vegan. Works with any restaurant website.',
};

const HOW_IT_WORKS = [
  {
    Icon: LinkIcon,
    title: 'Drop the link',
    desc: 'Homepage or menu page — the AI navigates to the menu on its own.',
  },
  {
    Icon: ScanIcon,
    title: 'The AI reads it all',
    desc: 'It reads PDFs and photo menus like a person would, and classifies every dish.',
  },
  {
    Icon: ShieldIcon,
    title: 'Verified, then served',
    desc: 'A second AI re-checks every veggie and vegan call for hidden ingredients.',
  },
];

const TRUST_SIGNALS = [
  { label: 'Two AI passes', sub: 'every veg label verified' },
  { label: 'Reads any menu', sub: 'PDF · photo · web' },
  { label: 'Watch it think', sub: 'live narration while it reads' },
  { label: 'Instant repeats', sub: 'scouted menus load at once' },
];

export default function HomePage() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="px-4 pt-16 pb-12 sm:pt-24 sm:pb-16 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-evergreen text-lime text-xs font-medium px-4 py-1.5 rounded-full mb-6 font-mono tracking-[0.12em] uppercase">
            <span className="live-dot" />
            <span>Plants × AI · Live in Dublin</span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold text-evergreen leading-tight mb-4 tracking-tight">
            Find what you can eat.{' '}
            <span className="bg-solar-gradient bg-clip-text text-transparent">Instantly.</span>
          </h1>

          <p className="text-lg text-evergreen/60 mb-8 max-w-lg mx-auto">
            Drop a restaurant link. Our AI reads the whole menu — PDFs, photo boards, the lot —
            and shows you every plant-powered dish before you&apos;ve found your coat.
          </p>

          <div className="flex justify-center">
            <HeroSearch />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="px-4 py-12 border-y-[1.5px] border-mint-200">
        <div className="max-w-3xl mx-auto">
          <h2 className="eyebrow text-center mb-8">{'/// Plant-finding, automated'}</h2>
          <div className="grid sm:grid-cols-3 gap-6">
            {HOW_IT_WORKS.map(({ Icon, title, desc }) => (
              <div key={title} className="card p-5 text-center">
                <Icon className="w-7 h-7 mx-auto mb-3 text-picky-600" />
                <h3 className="font-semibold text-evergreen mb-2">{title}</h3>
                <p className="text-sm text-evergreen/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Dublin CTA */}
      <section className="px-4 py-12">
        <div className="max-w-3xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl bg-evergreen p-6 sm:p-8">
            <div
              className="pointer-events-none absolute -right-10 -top-10 w-44 h-44 rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(198,245,66,0.25), transparent 70%)' }}
            />
            <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
              <div>
                <h2 className="text-xl font-bold text-lime mb-1">Dublin, pre-scouted</h2>
                <p className="text-sm text-mint-100">
                  Ten cool spots already read and verified — your next hang is in here.
                </p>
              </div>
              <a href="/dublin" className="btn-primary flex-shrink-0 text-sm whitespace-nowrap">
                Browse the guide →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Trust signals */}
      <section className="px-4 py-8 border-t-[1.5px] border-mint-200">
        <div className="max-w-3xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            {TRUST_SIGNALS.map((item) => (
              <div key={item.label} className="p-3">
                <p className="text-sm font-semibold text-evergreen">{item.label}</p>
                <p className="text-xs text-evergreen/50 mt-0.5">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
