'use client';

import { useState } from 'react';
import GuideFeedbackModal from './GuideFeedbackModal';
import { ChatIcon } from './icons';

interface Props {
  city: string;
  /** Which ground it sits on. 'dark' = the forest guide header, 'light' = paper.
   *  Kept explicit because a border/text pair readable on one is invisible on
   *  the other. Never pink — suggesting a restaurant isn't the key action. */
  tone?: 'dark' | 'light';
}

/** Opens the guide-level feedback modal (suggest a restaurant / flag an issue). */
export default function GuideFeedbackButton({ city, tone = 'light' }: Props) {
  const [open, setOpen] = useState(false);

  const styles =
    tone === 'dark'
      ? 'bg-paper text-forest border-2 border-paper hover:bg-white'
      : 'bg-forest text-paper border-2 border-forest hover:bg-forest-lift';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${styles}`}
      >
        <ChatIcon className="w-4 h-4" />
        Suggest a restaurant
      </button>
      {open && <GuideFeedbackModal city={city} onClose={() => setOpen(false)} />}
    </>
  );
}
