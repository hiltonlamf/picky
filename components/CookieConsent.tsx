'use client';

import { useEffect, useState } from 'react';

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const accepted = localStorage.getItem('picky-cookie-consent');
    if (!accepted) setVisible(true);
  }, []);

  function accept() {
    localStorage.setItem('picky-cookie-consent', '1');
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-50
                 card p-4 shadow-lg border-picky-100 animate-slide-up"
      role="dialog"
      aria-label="Cookie consent"
    >
      <p className="text-sm text-gray-600 mb-3">
        Picky uses minimal cookies to remember your preferences. We don&apos;t track you for advertising.
        Full details in our{' '}
        <a href="#" className="text-picky-600 underline hover:no-underline">
          Privacy Policy
        </a>
        .
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
