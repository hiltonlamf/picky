'use client';

import { useState } from 'react';
import { GENERAL_FEEDBACK_TYPES } from '@/lib/dietary-config';
import { CheckIcon, CloseIcon } from './icons';

interface Props {
  restaurantId: string;
  restaurantName: string | null;
  onClose: () => void;
}

const NOTES_PLACEHOLDER: Record<string, string> = {
  missing_dish: 'e.g. Falafel wrap — I saw it on the menu but it\'s not in the results',
  wrong_menu: 'e.g. This looks like the lunch menu, but I was checking dinner',
  feature_request: "e.g. A filter for gluten-free dishes would be amazing",
  other: 'Tell us more (optional)',
};

export default function FeedbackModal({ restaurantId, restaurantName, onClose }: Props) {
  const [feedbackType, setFeedbackType] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!feedbackType) return;
    setState('submitting');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId, restaurantName, feedbackType, notes }),
      });
      if (!res.ok) throw new Error('Failed');
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card w-full max-w-md p-6 animate-slide-up">
        {state === 'done' ? (
          <div className="text-center py-4">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-mint-100 flex items-center justify-center">
              <CheckIcon className="w-6 h-6 text-picky-600" />
            </div>
            <h3 className="text-lg font-semibold text-evergreen mb-2">Thanks for the feedback!</h3>
            <p className="text-sm text-evergreen/80 mb-4">
              We read every submission — this genuinely shapes what we build next.
            </p>
            <button onClick={onClose} className="btn-primary text-sm py-2 px-6">
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-evergreen">Share feedback</h3>
                <p className="text-sm text-evergreen/80 mt-0.5">
                  Missing dish, wrong menu, feature idea — anything goes.
                </p>
              </div>
              <button type="button" onClick={onClose} className="btn-ghost p-2 -mr-2 -mt-2 text-evergreen/80">
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>

            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-evergreen/80 mb-2">What&apos;s this about?</legend>
              <div className="space-y-2">
                {GENERAL_FEEDBACK_TYPES.map((issue) => (
                  <label key={issue.value} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="feedbackType"
                      value={issue.value}
                      checked={feedbackType === issue.value}
                      onChange={() => setFeedbackType(issue.value)}
                      className="mt-0.5 accent-picky-600"
                    />
                    <span className="text-sm text-evergreen/80">{issue.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mb-4">
              <label htmlFor="feedback-notes" className="text-sm font-medium text-evergreen/80 block mb-1">
                Details <span className="text-evergreen/80 font-normal">(optional)</span>
              </label>
              <textarea
                id="feedback-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={NOTES_PLACEHOLDER[feedbackType] ?? NOTES_PLACEHOLDER.other}
                rows={4}
                maxLength={1000}
                className="input-url resize-none text-sm !rounded-2xl"
              />
            </div>

            {state === 'error' && (
              <p className="text-sm text-red-500 mb-3">Something went wrong. Please try again.</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!feedbackType || state === 'submitting'}
                className="btn-primary flex-1 text-sm py-2"
              >
                {state === 'submitting' ? 'Sending...' : 'Send feedback'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost text-sm py-2">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
