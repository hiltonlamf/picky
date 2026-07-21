'use client';

import { useState } from 'react';
import { AlertIcon, CheckIcon } from './icons';
import { capture } from '@/lib/posthog-client';

interface Props {
  restaurantId: string;
  restaurantName: string | null;
}

/** One-click "this menu looks outdated" flag. Records a report in the existing
 *  feedback inbox (restaurant_feedback via /api/feedback) — it does NOT trigger
 *  a re-scrape, so a public click never spends AI budget. */
export default function FlagOutdatedButton({ restaurantId, restaurantName }: Props) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  async function flag() {
    if (state === 'sending' || state === 'done') return;
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId, restaurantName, feedbackType: 'menu_outdated', notes: '' }),
      });
      if (!res.ok) throw new Error('failed');
      capture('menu_outdated_flagged', { restaurant_id: restaurantId });
      setState('done');
    } catch {
      setState('error');
    }
  }

  if (state === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-picky-700">
        <CheckIcon className="w-3 h-3" />
        Thanks — we&rsquo;ll take a look
      </span>
    );
  }

  return (
    <button
      onClick={flag}
      disabled={state === 'sending'}
      className="inline-flex items-center gap-1 text-xs text-evergreen/60 hover:text-sun-800 hover:underline disabled:opacity-60"
    >
      <AlertIcon className="w-3 h-3" />
      {state === 'sending' ? 'Sending…' : state === 'error' ? 'Try again' : 'Menu look outdated?'}
    </button>
  );
}
