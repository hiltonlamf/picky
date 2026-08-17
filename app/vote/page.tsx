import type { Metadata } from 'next';
import CityVoteForm from '@/components/CityVoteForm';

export const metadata: Metadata = {
  title: 'Vote for the next city guide',
  description: 'Pick the city Picky should tofu-analyse next.',
  alternates: { canonical: '/vote' },
};

export default function VotePage() {
  return (
    <div className="min-h-screen bg-paper text-forest">
      <section className="relative overflow-hidden bg-forest-deep text-paper pt-16 pb-24 md:pt-20 md:pb-28">
        <div className="mesh mesh-animate" aria-hidden="true">
          <span className="w-[62%] h-[90%] left-[-10%] top-[-22%] bg-[#0f7a52] opacity-60" />
          <span className="w-[42%] h-[68%] left-[68%] top-[-10%] bg-azalea-500 opacity-35" />
          <span className="w-[30%] h-[48%] left-[40%] top-[52%] bg-aqua opacity-[0.16]" />
        </div>
        <div className="grain" aria-hidden="true" />

        <div className="band-inner">
          <span className="eyebrow-light">The next guide is up for grabs</span>
          <h1 className="font-display text-[clamp(2.55rem,6vw,4.8rem)] leading-[0.98] tracking-[-0.035em] mt-4 max-w-[15ch] text-balance">
            Put your city on <span className="text-azalea-400">Picky&rsquo;s map.</span>
          </h1>
          <p className="mt-6 max-w-[55ch] text-[1.08rem] md:text-xl leading-relaxed text-paper/85">
            Where should we read every menu next? Tap your city, add your email, and help bring a
            properly useful veggie guide to town.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3 font-mono text-[11px] tracking-[0.09em] uppercase text-paper/60">
            <span>01 · Pick a city</span>
            <span>02 · Make it official</span>
            <span>03 · We get tofu-analysing</span>
          </div>
        </div>
      </section>

      <section className="plate plate-paper relative z-[2] -mt-[var(--overlap)] rounded-t-[var(--overlap)] bg-paper py-14 md:py-20">
        <CityVoteForm />
      </section>
    </div>
  );
}
