'use client';

import { useEffect, useState } from 'react';
import { consentState, grantConsent, denyConsent } from '@/lib/posthog-client';

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only ask people we haven't asked. A previous "no" is remembered now,
    // so declining actually sticks instead of re-prompting every visit.
    if (consentState() === 'unasked') setVisible(true);
  }, []);

  function accept() {
    grantConsent();
    setVisible(false);
  }

  function decline() {
    denyConsent();
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-50
                 card p-4 shadow-glow animate-slide-up"
      role="dialog"
      aria-label="Cookie consent"
    >
      <p className="text-sm text-evergreen/80 mb-3">
        Platefully counts anonymous visits using a random ID set when you arrive — never linked to your
        identity, never used for advertising. Say yes and we&apos;ll also remember your preferences
        and measure which features actually get used, so we can make Platefully better.
      </p>
      {/* Equal-sized buttons on purpose: making "no" harder to click than
          "yes" is a dark pattern, and a compliance risk under GDPR. */}
      <div className="flex gap-2">
        <button onClick={accept} className="btn-primary text-sm py-2 px-4">
          Yes, that&apos;s fine
        </button>
        <button onClick={decline} className="btn-ghost text-sm py-2 px-4">
          No thanks
        </button>
      </div>
    </div>
  );
}
