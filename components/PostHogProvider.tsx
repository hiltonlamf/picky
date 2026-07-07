'use client';

import { useEffect } from 'react';
import { initPostHogIfConsented } from '@/lib/posthog-client';

/**
 * Boots PostHog for returning visitors who accepted cookies in a previous
 * session. First-time acceptance is handled by CookieConsent itself.
 */
export default function PostHogProvider() {
  useEffect(() => {
    initPostHogIfConsented();
  }, []);
  return null;
}
