import type { Metadata } from 'next';
import GuideCtaLink from '@/components/GuideCtaLink';
import HeroCta from '@/components/HeroCta';
import RestaurantCard from '@/components/RestaurantCard';
import SiteFeedbackButton from '@/components/SiteFeedbackButton';
import VoteCityLink from '@/components/VoteCityLink';
import { getFeaturedRestaurants } from '@/lib/db';
import { isPubliclyVisible } from '@/lib/review-flags';
import { CITY_VOTE_CTA, FEEDBACK_CTA, GUIDE, HERO, PILLARS, STORY } from '@/lib/home-copy';
import { SITE_DESCRIPTION, SITE_TITLE } from '@/lib/site-copy';
import type { Restaurant } from '@/types';

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  // The city guides now link to /?search=1 to open the hero's search directly.
  // Without a canonical that becomes a second indexable copy of the homepage.
  alternates: { canonical: '/' },
};

// Reads the Dublin guide for the preview strip. Cached for 5 minutes: it's a
// DB read on every cold render otherwise, and the guide barely moves.
export const revalidate = 300;

const TAG_TONE: Record<string, string> = {
  ai: 'bg-forest text-paper',
  human: 'bg-azalea-500 text-white',
  you: 'border-[2.5px] border-forest text-forest',
};

export default async function HomePage() {
  let featured: Restaurant[] = [];
  try {
    featured = await getFeaturedRestaurants('dublin');
  } catch {
    // No DB (or no credentials, as in CI's build) — the guide strip is simply
    // omitted and the rest of the page still renders.
  }
  const visible = featured.filter(isPubliclyVisible);
  const preview = visible.slice(0, 3);

  return (
    <div className="flex flex-col bg-forest">
      {/* ---------------- Hero ---------------- */}
      <section className="relative overflow-hidden bg-forest-deep text-paper pt-14 md:pt-16 pb-[calc(56px+var(--overlap))]">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[70%] h-[88%] left-[-10%] top-[-18%] bg-[#0f7a52] opacity-55" />
          <span className="w-[58%] h-[76%] left-[40%] top-[16%] bg-[#14563c] opacity-75" />
          <span className="w-[34%] h-[48%] left-[70%] top-[-14%] bg-azalea-500 opacity-30" />
          <span className="w-[26%] h-[38%] left-[20%] top-[44%] bg-aqua opacity-[0.14]" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner">
          <span className="glass inline-flex items-center gap-2.5 rounded-full px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase text-paper/90">
            <span className="w-1.5 h-1.5 rounded-full bg-azalea-500 shadow-[0_0_12px_#ff2d8f] animate-blink" />
            {HERO.badge}
          </span>

          <h1 className="font-display text-[clamp(2.4rem,4.4vw,3.6rem)] leading-[1.07] tracking-[-0.025em] mt-5 mb-4 max-w-[34ch] text-balance">
            {HERO.headline.before}
            <span className="text-azalea-400">{HERO.headline.accent}</span>
            {HERO.headline.after}
          </h1>

          <p className="text-[1.06rem] leading-relaxed text-paper/90 max-w-[50ch]">
            {HERO.sub}
          </p>

          <HeroCta />

          <p className="mt-8 text-sm text-paper/70">{HERO.support}</p>
        </div>
      </section>

      {/* ---------------- Dublin guide, right under the search ---------------- */}
      <section className="band plate plate-paper z-[2] bg-paper text-forest">
        <div className="band-inner">
          <div className="flex flex-wrap items-end justify-between gap-x-[52px] gap-y-6">
            <div className="flex-1 basis-[420px]">
              <span className="eyebrow-pink">{GUIDE.eyebrow}</span>
              <h2 className="font-display text-[clamp(1.8rem,3.5vw,2.5rem)] leading-[1.03] tracking-[-0.025em] mt-3 max-w-[24ch] text-balance">
                <span className="mr-2" role="img" aria-label="Ireland">🇮🇪</span>
                {GUIDE.headline}
              </h2>
              <p className="mt-3.5 max-w-[60ch] leading-relaxed text-forest/85">{GUIDE.lede}</p>
            </div>
            <GuideCtaLink href="/dublin" label={GUIDE.cta} city="dublin" placement="band" />
          </div>

          {preview.length > 0 && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-8">
              {preview.map((r) => (
                <RestaurantCard key={r.id} restaurant={r} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ---------------- The story ---------------- */}
      <section id="story" className="band plate z-[3] bg-forest text-paper scroll-mt-[78px]">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[60%] h-[80%] left-[-14%] top-[-12%] bg-[#0f7a52] opacity-50" />
          <span className="w-[38%] h-[56%] left-[64%] top-[-10%] bg-azalea-500 opacity-[0.26]" />
          <span className="w-[44%] h-[62%] left-[34%] top-[44%] bg-[#14563c] opacity-60" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner grid md:grid-cols-[0.92fr_1.08fr] gap-10 items-start">
          <div>
            <span className="eyebrow-light">{STORY.eyebrow}</span>
            <h2 className="font-display text-[clamp(1.9rem,3.9vw,2.8rem)] leading-[1.03] tracking-[-0.025em] mt-3.5 text-azalea-400 text-balance">
              {STORY.headline}
            </h2>
            <div className="glass inline-flex items-center gap-3 rounded-[20px] px-5 py-3.5 mt-7">
              <div>
                <p className="font-display text-base text-paper">{STORY.bylineName}</p>
                <p className="font-mono text-[11px] tracking-[0.09em] uppercase text-paper mt-0.5">
                  {STORY.bylineRole}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-5">
            {STORY.paragraphs.map((p) => (
              <p key={p} className="text-[1.02rem] leading-[1.7] text-paper/90 max-w-[58ch]">
                {p}
              </p>
            ))}
            <p className="font-display text-[clamp(1.2rem,2.3vw,1.6rem)] leading-tight text-azalea-400 border-l-[6px] border-azalea-500 pl-[18px]">
              {STORY.pullQuote}
            </p>
            {STORY.paragraphsAfter.map((p) => (
              <p key={p} className="text-[1.02rem] leading-[1.7] text-paper/90 max-w-[58ch]">
                {p}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- How Picky works: AI / human / you ---------------- */}
      <section id="how" className="band plate plate-paper z-[4] bg-paper text-forest scroll-mt-[78px]">
        <div className="band-inner">
          <span className="eyebrow-pink">{PILLARS.eyebrow}</span>
          <h2 className="font-display text-[clamp(1.7rem,3.3vw,2.35rem)] leading-[1.03] tracking-[-0.025em] mt-3 max-w-[24ch]">
            {PILLARS.headline}
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-9">
            {PILLARS.cards.map((card) => (
              <div
                key={card.tag}
                className={`flex flex-col gap-3 pt-5 border-t-[3px] ${
                  card.tone === 'human' ? 'border-azalea-500' : 'border-forest'
                }`}
              >
                <span
                  className={`self-start font-display text-base rounded-full px-5 py-2.5 leading-none ${
                    TAG_TONE[card.tone]
                  }`}
                >
                  {card.tag}
                </span>
                <h3 className="font-display text-xl">{card.title}</h3>
                <p className="text-[0.89rem] leading-relaxed text-forest/85">{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Vote for the next guide ---------------- */}
      <section className="band plate z-[5] bg-forest text-paper pb-[78px]">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[52%] h-[86%] left-[56%] top-[-20%] bg-azalea-500 opacity-30" />
          <span className="w-[56%] h-[78%] left-[-8%] top-[20%] bg-[#0f7a52] opacity-55" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner">
          <div className="flex flex-wrap items-center justify-between gap-7">
            <div>
              <span className="eyebrow-light">{CITY_VOTE_CTA.eyebrow}</span>
              <h2 className="font-display text-[clamp(1.7rem,3.5vw,2.5rem)] leading-[1.03] tracking-[-0.025em] mt-3 max-w-[20ch]">
                {CITY_VOTE_CTA.headline.before}
                <span className="text-azalea-400">{CITY_VOTE_CTA.headline.accent}</span>
              </h2>
              <p className="mt-3 text-[0.95rem] leading-relaxed text-paper/80 max-w-[52ch]">
                {CITY_VOTE_CTA.body}
              </p>
            </div>
            <VoteCityLink placement="bottom" className="btn-cta">
              {CITY_VOTE_CTA.button}
            </VoteCityLink>
          </div>

          <div className="my-10 h-px bg-paper/15" />

          <div className="flex flex-wrap items-center justify-between gap-7">
          <div>
            <h2 className="font-display text-[clamp(1.5rem,3vw,2.1rem)] leading-[1.03] tracking-[-0.025em] max-w-[18ch]">
              {FEEDBACK_CTA.headline.before}
              <span className="text-azalea-400">{FEEDBACK_CTA.headline.accent}</span>
            </h2>
            <p className="mt-2.5 text-[0.93rem] leading-relaxed text-paper/85 max-w-[46ch]">
              {FEEDBACK_CTA.body}
            </p>
          </div>
          <SiteFeedbackButton variant="cta" label={FEEDBACK_CTA.button} />
          </div>
        </div>
      </section>
    </div>
  );
}
