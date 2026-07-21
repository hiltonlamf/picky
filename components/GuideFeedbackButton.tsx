'use client';

import { useState } from 'react';
import GuideFeedbackModal from './GuideFeedbackModal';
import { ChatIcon } from './icons';

/** Opens the guide-level feedback modal (suggest a restaurant / flag an issue). */
export default function GuideFeedbackButton({ city }: { city: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border-2 border-mint-200 text-sm text-evergreen/80 hover:border-picky-300 hover:text-evergreen transition-colors"
      >
        <ChatIcon className="w-4 h-4" />
        Suggest a restaurant
      </button>
      {open && <GuideFeedbackModal city={city} onClose={() => setOpen(false)} />}
    </>
  );
}
