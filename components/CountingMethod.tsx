'use client';

import { useRef } from 'react';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';
import { COUNTING_METHOD_SUMMARY, COUNTING_METHOD_BODY } from '@/lib/site-copy';

interface Props {
  /** Which page this is on, so we can tell guide curiosity from menu curiosity. */
  surface: 'guide' | 'restaurant';
  className?: string;
}

/**
 * The collapsed "How we count veggie dishes" note, shown on both the city guide
 * and the restaurant page. Since the headline number deliberately leaves things
 * out (desserts, sauces, plain breads), the page has to be able to say so.
 *
 * Built on native <details>/<summary> on purpose: it works with JavaScript off,
 * and is keyboard- and screen-reader-accessible without any ARIA of our own.
 */
export default function CountingMethod({ surface, className = '' }: Props) {
  // Fire-once per visit, guarded by a ref rather than state — a "did they reach
  // X" event that double-fires corrupts every rate built on it.
  const reported = useRef(false);

  function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || reported.current) return;
    reported.current = true;
    capture(EVENTS.COUNTING_METHOD_EXPANDED, { surface });
  }

  return (
    <details onToggle={onToggle} className={`group ${className}`}>
      <summary
        className="cursor-pointer list-none inline-flex items-center gap-1.5 text-xs text-forest/65
                   hover:text-forest focus-visible:outline-none focus-visible:ring-4
                   focus-visible:ring-azalea-500/25 rounded-full"
      >
        <svg
          viewBox="0 0 12 12"
          className="w-2.5 h-2.5 transition-transform duration-150 group-open:rotate-90
                     motion-reduce:transition-none"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        {COUNTING_METHOD_SUMMARY}
      </summary>
      <div className="mt-2 max-w-[62ch] space-y-2 text-xs leading-relaxed text-forest/75">
        {COUNTING_METHOD_BODY.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}
