'use client';

import { useState } from 'react';
import { GUIDE_FEEDBACK_TYPES } from '@/lib/dietary-config';
import { capture } from '@/lib/posthog-client';

interface Props {
  city: string;
  onClose: () => void;
}

/** Guide-level feedback: suggest a restaurant to add, or flag an issue with one
 *  that's listed. Posts to the shared /api/feedback route with a `city` and no
 *  restaurantId — it lands in the admin feedback inbox. No AI spend. */
export default function GuideFeedbackModal({ city, onClose }: Props) {
  const [type, setType] = useState(GUIDE_FEEDBACK_TYPES[0].value);
  const [suggestion, setSuggestion] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  const cityLabel = city.charAt(0).toUpperCase() + city.slice(1);
  const isSuggest = type === 'suggest_restaurant';

  async function submit() {
    setState('submitting');
    try {
      // Fold the suggested restaurant (name / link) into the notes so the admin
      // sees it inline without a schema change.
      const body = isSuggest && suggestion.trim() ? `Suggested: ${suggestion.trim()}\n${notes}`.trim() : notes;
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackType: type, notes: body, city }),
      });
      if (!res.ok) throw new Error('failed');
      capture('guide_feedback_submitted', { city, feedback_type: type });
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-evergreen/40 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {state === 'done' ? (
          <div className="text-center py-4">
            <p className="text-lg font-bold text-evergreen mb-1">Thanks! 🌱</p>
            <p className="text-sm text-evergreen/80 mb-5">We&rsquo;ll take a look at your feedback for the {cityLabel} guide.</p>
            <button onClick={onClose} className="btn-primary text-sm">Close</button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-lg font-bold text-evergreen">{cityLabel} guide feedback</h2>
              <button onClick={onClose} aria-label="Close" className="text-evergreen/50 hover:text-evergreen font-bold text-lg leading-none">×</button>
            </div>
            <p className="text-sm text-evergreen/80 mb-4">Missing a spot, or something looks off? Tell us.</p>

            <div className="space-y-2 mb-4">
              {GUIDE_FEEDBACK_TYPES.map((t) => (
                <label key={t.value} className="flex items-start gap-2 text-sm text-evergreen cursor-pointer">
                  <input
                    type="radio"
                    name="guide-feedback-type"
                    value={t.value}
                    checked={type === t.value}
                    onChange={() => setType(t.value)}
                    className="mt-1 accent-picky-600"
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>

            {isSuggest && (
              <input
                type="text"
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
                placeholder="Restaurant name or website link"
                className="w-full rounded-full border border-mint-200 px-4 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-picky-500"
              />
            )}

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else? (optional)"
              rows={3}
              maxLength={1000}
              className="w-full rounded-lg border border-mint-200 px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-picky-500"
            />

            {state === 'error' && <p className="text-sm text-red-500 mb-2">Couldn&rsquo;t send that — please try again.</p>}

            <div className="flex gap-2">
              <button
                onClick={submit}
                disabled={state === 'submitting' || (isSuggest && !suggestion.trim() && !notes.trim())}
                className="btn-primary text-sm px-5 py-2 disabled:opacity-60"
              >
                {state === 'submitting' ? 'Sending…' : 'Send feedback'}
              </button>
              <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
