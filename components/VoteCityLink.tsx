'use client';

import Link from 'next/link';
import { EVENTS } from '@/lib/analytics';
import { capture } from '@/lib/posthog-client';

interface VoteCityLinkProps {
  placement: 'hero' | 'bottom';
  className?: string;
  children: React.ReactNode;
}

export default function VoteCityLink({ placement, className, children }: VoteCityLinkProps) {
  return (
    <Link
      href="/vote"
      className={className}
      onClick={() => capture(EVENTS.CITY_VOTE_CTA_CLICKED, { placement })}
    >
      {children}
    </Link>
  );
}
