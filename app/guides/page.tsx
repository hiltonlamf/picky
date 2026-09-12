import type { Metadata } from 'next';
import CityGuideList from '@/components/CityGuideList';
import GuideIndexTracker from '@/components/GuideIndexTracker';
import VoteCityLink from '@/components/VoteCityLink';
import { listCityGuideLinks } from '@/lib/db';
import { isAdminViewer } from '@/lib/admin-viewer';
import {
  GUIDE_HUMAN_LINE,
  GUIDE_INDEX,
  GUIDE_INDEX_TITLE,
  guideIndexMetaDescription,
} from '@/lib/site-copy';
import type { CityGuide } from '@/types';

// Reads the DB and the admin cookie on every request, so it can never be
// statically prerendered — CI builds without database credentials, and a
// prerendered copy would also serve a stale list the moment a guide is
// published.
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function generateMetadata(): Promise<Metadata> {
  // Public guides only — a draft city must not leak into a meta description.
  const guides = await listCityGuideLinks().catch(() => [] as CityGuide[]);
  return {
    title: GUIDE_INDEX_TITLE,
    description: guideIndexMetaDescription(guides.map((g) => g.displayName)),
    alternates: { canonical: '/guides' },
  };
}

export default async function GuidesIndexPage() {
  // Drafts are shown ONLY to a signed-in admin, so a guide can be checked here
  // before it goes live. isAdminViewer fails closed.
  const isAdmin = await isAdminViewer();

  let guides: CityGuide[] = [];
  try {
    guides = await listCityGuideLinks({ includeDrafts: isAdmin });
  } catch {
    // DB unavailable — fall through to the empty state rather than a 500.
  }

  return (
    <div className="bg-paper">
      <section className="relative overflow-hidden bg-forest-deep text-paper pt-14 pb-16">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[66%] h-[86%] left-[-12%] top-[-16%] bg-[#0f7a52] opacity-55" />
          <span className="w-[54%] h-[74%] left-[44%] top-[14%] bg-[#14563c] opacity-75" />
          <span className="w-[32%] h-[46%] left-[68%] top-[-12%] bg-azalea-500 opacity-[0.28]" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner">
          <span className="eyebrow-light">{GUIDE_INDEX.eyebrow}</span>
          <h1 className="font-display text-[clamp(2rem,4.6vw,3.1rem)] leading-[1.04] tracking-[-0.025em] mt-4 mb-4 max-w-[18ch] text-balance">
            {GUIDE_INDEX.headline}
          </h1>
          <p className="text-paper/90 max-w-[62ch] text-[1.02rem] leading-relaxed">
            {GUIDE_INDEX.intro}
          </p>
          <p className="text-paper/70 max-w-[62ch] text-sm mt-3">{GUIDE_HUMAN_LINE}</p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 py-12">
        <GuideIndexTracker guideCount={guides.length} />

        {guides.length > 0 ? (
          <CityGuideList guides={guides} variant="hub" showDraftBadge={isAdmin} />
        ) : (
          <div className="card p-6 mb-6 text-center text-evergreen/70">
            No city guides are live yet.
          </div>
        )}

        {/* One honest way onward for a city we don't cover, rather than a page
            padded with greyed-out cities that go nowhere. */}
        <div className="relative overflow-hidden rounded-3xl bg-forest text-paper p-7 sm:p-9 mt-12">
          <div className="mesh" aria-hidden="true">
            <span className="w-[52%] h-[90%] left-[58%] top-[-22%] bg-azalea-500 opacity-30" />
            <span className="w-[50%] h-[80%] left-[-8%] top-[16%] bg-[#0f7a52] opacity-50" />
          </div>
          <div className="relative z-[2]">
            <span className="eyebrow-light">{GUIDE_INDEX.vote.eyebrow}</span>
            <h2 className="font-display text-2xl mt-2 mb-5">{GUIDE_INDEX.vote.title}</h2>
            <VoteCityLink placement="bottom" className="btn-vote-glass">
              {GUIDE_INDEX.vote.button}
            </VoteCityLink>
          </div>
        </div>
      </div>
    </div>
  );
}
