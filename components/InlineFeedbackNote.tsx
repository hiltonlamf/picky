'use client';

import { useId, useRef, useState } from 'react';
import { capture } from '@/lib/posthog-client';
import { EVENTS } from '@/lib/analytics-events';

type Props = {
  /** Where this sits — becomes the PostHog `surface` property and the feedback_type. */
  surface: 'menu_picker' | 'no_menu' | 'parse_error';
  /** Prompt shown when collapsed. */
  prompt: string;
  /** Placeholder inside the textarea. */
  placeholder: string;
  restaurantId?: string | null;
  restaurantName?: string | null;
  /** Free-form context for the admin inbox (menu labels offered, error shown). */
  context?: string | null;
  /** The picker sits on the dark glass hero; the restaurant page is on paper. */
  tone?: 'light' | 'dark';
};

const FEEDBACK_TYPE: Record<Props['surface'], string> = {
  menu_picker: 'menu_choice_note',
  no_menu: 'no_menu_note',
  parse_error: 'parse_error_note',
};

/**
 * A single free-text note, captured inline at the moments we get it wrong.
 *
 * Deliberately not a modal: these appear when something has just failed or when
 * the user is mid-decision, and a dialog at that moment is friction. Collapsed
 * to one quiet line until asked for, so it never competes with the primary
 * action (submit the menu, pick a menu, try another restaurant).
 *
 * Posts to the existing /api/feedback endpoint — no new table, no new route.
 */
export default function InlineFeedbackNote({
  surface,
  prompt,
  placeholder,
  restaurantId = null,
  restaurantName = null,
  context = null,
  tone = 'light',
}: Props) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const textareaId = useId();
  // Fire-once: a step that fires twice corrupts every rate built on it.
  const openedRef = useRef(false);

  const dark = tone === 'dark';

  function reveal() {
    setOpen(true);
    if (!openedRef.current) {
      openedRef.current = true;
      capture(EVENTS.INLINE_FEEDBACK_OPENED, { surface });
    }
  }

  async function send() {
    const trimmed = notes.trim();
    if (!trimmed || state !== 'idle') return;
    setState('sending');
    // Optimistic: the note is a gift to us, not a transaction the user is
    // waiting on. Never show them an error for it.
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId,
          restaurantName,
          feedbackType: FEEDBACK_TYPE[surface],
          notes: context ? `${trimmed}\n\n---\n${context}` : trimmed,
        }),
      });
    } catch {
      // Swallowed on purpose — see above.
    }
    capture(EVENTS.INLINE_FEEDBACK_SUBMITTED, { surface, length: trimmed.length });
    setState('sent');
  }

  if (state === 'sent') {
    return (
      <p
        role="status"
        aria-live="polite"
        className={`text-sm ${dark ? 'text-paper/80' : 'text-evergreen/75'}`}
      >
        Thanks — that genuinely helps us fix it.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={reveal}
        className={`text-sm underline underline-offset-4 transition-colors ${
          dark ? 'text-paper/70 hover:text-paper' : 'text-evergreen/60 hover:text-evergreen'
        }`}
      >
        {prompt}
      </button>
    );
  }

  return (
    <div className="w-full">
      <label
        htmlFor={textareaId}
        className={`block text-sm mb-1.5 ${dark ? 'text-paper/80' : 'text-evergreen/75'}`}
      >
        {prompt}
      </label>
      <textarea
        id={textareaId}
        autoFocus
        rows={3}
        maxLength={1000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
          dark
            ? 'glass text-paper placeholder:text-paper/45 focus:ring-azalea-400'
            : 'border border-mint-200 bg-white text-evergreen placeholder:text-evergreen/40 focus:ring-picky-500'
        }`}
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={!notes.trim() || state === 'sending'}
          className={`text-sm font-semibold rounded-full px-4 py-1.5 transition-colors disabled:opacity-45 ${
            dark ? 'bg-azalea-500 text-white hover:bg-azalea-400' : 'bg-forest text-paper hover:bg-forest-lift'
          }`}
        >
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={`text-sm ${dark ? 'text-paper/60 hover:text-paper' : 'text-evergreen/55 hover:text-evergreen'}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
