'use client';

import { useEffect, useState } from 'react';
import { FIRST_ANALYSIS_KEY, NPS_DONE_KEY } from '@/lib/telemetry';
import { CloseIcon } from './icons';

// Day 7+, not day 1: the score only means something once someone has had
// a real chance to use (or abandon) Picky.
const NPS_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export default function NPSPrompt() {
  const [visible, setVisible] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(NPS_DONE_KEY)) return;
    const first = Number(localStorage.getItem(FIRST_ANALYSIS_KEY));
    if (Number.isFinite(first) && first > 0 && Date.now() - first >= NPS_DELAY_MS) {
      setVisible(true);
    }
  }, []);

  function dismiss() {
    // Answered or waved away, either way: never nag twice.
    localStorage.setItem(NPS_DONE_KEY, '1');
    setVisible(false);
  }

  async function submit() {
    if (score === null || submitting) return;
    setSubmitting(true);
    try {
      await fetch('/api/nps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, notes }),
      });
      localStorage.setItem(NPS_DONE_KEY, '1');
      setThanks(true);
      setTimeout(() => setVisible(false), 2000);
    } catch {
      // Losing one NPS answer beats showing the user an error for it.
      dismiss();
    }
  }

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-50
                 card p-4 shadow-glow animate-slide-up"
      role="dialog"
      aria-label="Feedback question"
    >
      {thanks ? (
        <p className="text-sm text-evergreen font-medium">Thanks — that really helps! 🌱</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 mb-3">
            <p className="text-sm text-evergreen/80">
              How likely are you to recommend Picky to a friend?
            </p>
            <button
              onClick={dismiss}
              className="text-evergreen/80 hover:text-evergreen p-0.5 flex-shrink-0"
              aria-label="Dismiss"
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-1" role="radiogroup" aria-label="Score from 0 to 10">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                key={n}
                onClick={() => setScore(n)}
                role="radio"
                aria-checked={score === n}
                className={`w-8 h-8 rounded-full border-2 text-xs font-semibold transition-colors ${
                  score === n
                    ? 'border-picky-500 bg-picky-500 text-white'
                    : 'border-mint-200 text-evergreen/80 hover:border-picky-300'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-evergreen/80 mb-3">
            <span>Not likely</span>
            <span>Very likely</span>
          </div>
          {score !== null && (
            <>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
                rows={2}
                placeholder="Anything we should improve? (optional)"
                className="w-full text-sm rounded-xl border-2 border-mint-200 px-3 py-2 mb-3
                           focus:outline-none focus:ring-4 focus:ring-picky-500/15 focus:border-picky-500"
              />
              <button onClick={submit} disabled={submitting} className="btn-primary text-sm py-2 px-4">
                {submitting ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
