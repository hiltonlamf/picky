'use client';

import { useEffect } from 'react';
import { initPostHog } from '@/lib/posthog-client';

/**
 * Boots PostHog on every page load.
 *
 * Unlike the previous version, this runs for *everyone*, not only visitors who
 * already accepted cookies — before consent it starts in a memory-only mode
 * that stores nothing on the device and records nothing but pageviews, so we
 * can count arrivals without following anyone around. See lib/posthog-client.
 */
export default function PostHogProvider() {
  useEffect(() => {
    initPostHog();
  }, []);
  return null;
}
