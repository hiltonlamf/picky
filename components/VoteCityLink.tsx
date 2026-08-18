'use client';

import Link from 'next/link';
import { capture } from '@/lib/posthog-client';
import { cityVoteCtaClickedEvent } from '@/lib/analytics-events';

interface VoteCityLinkProps {
  placement: 'hero' | 'bottom';
  className?: string;
  children: React.ReactNode;
}

export default function VoteCityLink({ placement, className, children }: VoteCityLinkProps) {
  const analytics = cityVoteCtaClickedEvent(placement);
  return (
    <Link
      href="/vote"
      className={className}
      onClick={() => capture(analytics.event, analytics.properties)}
    >
      {children}
    </Link>
  );
}
