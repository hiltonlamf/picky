'use client';

import { useEffect } from 'react';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';

/**
 * Records arrival at /guides. Same shape as GuideViewTracker, for the same
 * reason: it keeps the hub page a server component by isolating the one thing
 * on it that needs the browser.
 *
 * `guide_count` is carried so the "did anyone use the index" question can be
 * read against how much there actually was to browse — a low click-through with
 * three cities means something different from a low one with fifty.
 */
export default function GuideIndexTracker({ guideCount }: { guideCount: number }) {
  useEffect(() => {
    capture(EVENTS.GUIDE_INDEX_VIEWED, { guide_count: guideCount });
  }, [guideCount]);
  return null;
}
