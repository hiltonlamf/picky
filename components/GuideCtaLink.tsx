'use client';

import Link from 'next/link';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';

/**
 * A city-guide call to action that reports its own click.
 *
 * `guide_viewed` fires on *arrival* at /dublin, which means a click that never
 * landed — a bounce, a back button, a slow route — looked exactly like nobody
 * clicking at all. Both homepage guide CTAs render through here so the two
 * placements can be compared, which is the measurement the guide-led hero
 * stands or falls on.
 *
 * Deliberately NOT used for the header, footer or restaurant-page links: those
 * are navigation, not calls to action, and folding them in would make
 * `placement` mean nothing.
 */
export default function GuideCtaLink({
  href,
  label,
  city,
  placement,
  className = 'btn-guide',
}: {
  href: string;
  label: string;
  city: string;
  placement: 'hero' | 'band';
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={className}
      // Client-side navigation doesn't unload the document, so the queued
      // request survives the transition — no sendBeacon needed here.
      onClick={() => capture(EVENTS.GUIDE_CTA_CLICKED, { city, placement })}
    >
      {label}
    </Link>
  );
}
