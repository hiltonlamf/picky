import type { ReactNode } from 'react';

export default function PolicyPage({ title, updated, children }: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-paper text-forest">
      <article className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <p className="eyebrow-pink">Platefully</p>
        <h1 className="font-display text-[clamp(2.1rem,5vw,3.5rem)] leading-tight mt-3">{title}</h1>
        <p className="text-sm text-forest/60 mt-3">Last updated {updated}</p>
        <div className="mt-10 space-y-8 text-[0.96rem] leading-relaxed text-forest/85 [&_h2]:font-display [&_h2]:text-xl [&_h2]:text-forest [&_h2]:mb-2 [&_a]:text-azalea-700 [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">
          {children}
        </div>
      </article>
    </div>
  );
}
