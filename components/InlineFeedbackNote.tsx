'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { capture } from '@/lib/posthog-client';
import { captureError } from '@/lib/analytics';
import { EVENTS } from '@/lib/analytics-events';

type Props = {
  /** Where this sits — becomes the PostHog `surface` property and the feedback_type. */
  surface: 'menu_picker' | 'no_menu' | 'parse_error';
  /**
   * `link` starts as one quiet line and opens on click — right for a screen
   * where the user is mid-decision and something else is the primary action.
   * `expanded` is always open, no click needed — right for a dead end, where
   * there is no primary action left and asking them to click first loses most
   * of the feedback we would have got.
   */
  variant?: 'link' | 'expanded';
  /** Prompt shown when collapsed, and as the field's label once open. */
  prompt: string;
  /** Second line under the prompt. `expanded` only — the link variant has no room. */
  description?: string;
  /** Placeholder inside the textarea. */
  placeholder: string;
  /** Copy of the confirmation shown after sending. */
  thanks?: string;
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

const DEFAULT_THANKS = 'Thanks — that genuinely helps us fix it.';

/**
 * A single free-text note, captured inline at the moments we get it wrong.
 *
 * Deliberately not a modal: these appear when something has just failed or when
 * the user is mid-decision, and a dialog at that moment is friction.
 *
 * Posts to the existing /api/feedback endpoint — no new table, no new route.
 */
export default function InlineFeedbackNote({
  surface,
  variant = 'link',
  prompt,
  description,
  placeholder,
  thanks = DEFAULT_THANKS,
  restaurantId = null,
  restaurantName = null,
  context = null,
  tone = 'light',
}: Props) {
  const expanded = variant === 'expanded';
  const [open, setOpen] = useState(expanded);
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const textareaId = useId();
  const descriptionId = useId();
  // Fire-once: a step that fires twice corrupts every rate built on it. The
  // restaurant page re-renders on every poll, so a bare capture() here would
  // count one visitor many times.
  const openedRef = useRef(false);
  const shownRef = useRef(false);

  const dark = tone === 'dark';

  // `shown` and `opened` are deliberately different events. Merging them would
  // silently redefine inline_feedback_opened from "they chose to tell us" to
  // "we showed them a box", and every response rate built on it would drop
  // without anything looking broken.
  useEffect(() => {
    if (!expanded || shownRef.current) return;
    shownRef.current = true;
    capture(EVENTS.INLINE_FEEDBACK_SHOWN, { surface });
  }, [expanded, surface]);

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
    // Optimistic towards the USER: the note is a gift to us, not a transaction
    // they are waiting on, so they get the thank-you either way — someone who
    // has just been let down should not also be handed an error.
    //
    // Not optimistic towards US: a note that never arrives is feedback lost at
    // the exact moment we most need it, and the old code could not tell the
    // difference between "saved" and "rejected with a 429". Report it.
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId,
          restaurantName,
          feedbackType: FEEDBACK_TYPE[surface],
          notes: context ? `${trimmed}\n\n---\n${context}` : trimmed,
        }),
      });
      if (!res.ok) {
        captureError({
          surface: `inline_feedback_${surface}`,
          message: `Feedback POST returned ${res.status}`,
          restaurantId,
          extra: { status: res.status },
        });
      }
    } catch (err) {
      captureError({
        surface: `inline_feedback_${surface}`,
        message: err instanceof Error ? err.message : 'Feedback POST failed',
        restaurantId,
      });
    }
    capture(EVENTS.INLINE_FEEDBACK_SUBMITTED, { surface, length: trimmed.length, variant });
    setState('sent');
  }

  if (state === 'sent') {
    const confirmation = (
      <p
        role="status"
        aria-live="polite"
        className={`text-sm ${dark ? 'text-paper/80' : 'text-evergreen/75'}`}
      >
        {thanks}
      </p>
    );
    // Keep the panel's frame so the page doesn't jump when the form collapses
    // into one line of text.
    return expanded ? <Panel dark={dark}>{confirmation}</Panel> : confirmation;
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

  const form = (
    <>
      <label
        htmlFor={textareaId}
        className={`block mb-1 ${
          expanded
            ? `text-sm font-semibold ${dark ? 'text-paper' : 'text-evergreen'}`
            : `text-sm mb-1.5 ${dark ? 'text-paper/80' : 'text-evergreen/75'}`
        }`}
      >
        {prompt}
      </label>
      {expanded && description && (
        <p id={descriptionId} className={`text-xs mb-3 ${dark ? 'text-paper/70' : 'text-evergreen/80'}`}>
          {description}
        </p>
      )}
      <textarea
        id={textareaId}
        // Tie the "a real person reads every message" line to the field, so a
        // screen-reader user hears the reassurance, not just "Not what you were
        // hoping for?, edit text".
        aria-describedby={expanded && description ? descriptionId : undefined}
        // Only autofocus when the user just asked for the field. Stealing focus
        // on page load would scroll a disappointed visitor past the heading
        // explaining what went wrong.
        autoFocus={!expanded}
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
        {/* Nothing to cancel back to when the field was never hidden. */}
        {!expanded && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={`text-sm ${dark ? 'text-paper/60 hover:text-paper' : 'text-evergreen/55 hover:text-evergreen'}`}
          >
            Cancel
          </button>
        )}
      </div>
    </>
  );

  return expanded ? <Panel dark={dark}>{form}</Panel> : <div className="w-full">{form}</div>;
}

/** The expanded variant gets its own surface so it reads as a second, separate
 *  ask rather than as more of the menu-upload card above it. */
function Panel({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`w-full rounded-2xl p-4 text-left ${
        dark ? 'glass' : 'border border-mint-200 bg-mint-50/60'
      }`}
    >
      {children}
    </div>
  );
}
