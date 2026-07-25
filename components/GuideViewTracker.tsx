'use client';

import { useEffect } from 'react';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics';

/**
 * Opens the city-guide funnel: guide_viewed → results_viewed(source='guide')
 * → results_engaged.
 *
 * A separate client component because the guide pages are server-rendered and
 * this is the only thing on them that needs the browser. Deliberately does NOT
 * track which card was clicked — `results_viewed` already derives
 * `source: 'guide'` from the referrer, so the funnel closes without converting
 * RestaurantCard into a client component and shipping its whole render to the
 * browser. The trade is losing click position, which isn't worth that cost.
 */
export default function GuideViewTracker({
  city,
  restaurantCount,
}: {
  city: string;
  restaurantCount: number;
}) {
  useEffect(() => {
    capture(EVENTS.GUIDE_VIEWED, { city, restaurant_count: restaurantCount });
  }, [city, restaurantCount]);
  return null;
}
