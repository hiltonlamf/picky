'use client';

import { useEffect, useState } from 'react';
import { initPostHogIfConsented } from '@/lib/posthog-client';

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const accepted = localStorage.getItem('picky-cookie-consent');
    if (!accepted) setVisible(true);
  }, []);

  function accept() {
    localStorage.setItem('picky-cookie-consent', '1');
    // Analytics only ever starts here (or on a later visit) — after consent.
    initPostHogIfConsented();
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
        Picky uses minimal cookies to remember your preferences and measure anonymous usage — a random ID that isn&apos;t linked to your identity. We don&apos;t track you for advertising.
      </p>
      <div className="flex gap-2">
        <button onClick={accept} className="btn-primary text-sm py-2 px-4">
          Got it
        </button>
        <button
          onClick={() => setVisible(false)}
          className="btn-ghost text-sm py-2 px-4"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
