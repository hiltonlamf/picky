'use client';

import { useState } from 'react';
import { REPORT_ISSUE_TYPES } from '@/lib/dietary-config';

interface Props {
  dishId: string;
  dishName: string;
  onClose: () => void;
}

export default function ReportModal({ dishId, dishName, onClose }: Props) {
  const [issueType, setIssueType] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!issueType) return;
    setState('submitting');
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dishId, issueType, notes }),
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
            <div className="text-3xl mb-3">✅</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Thanks for flagging this!</h3>
            <p className="text-sm text-gray-500 mb-4">
              We&apos;ll review your report and update the classification if needed.
            </p>
            <button onClick={onClose} className="btn-primary text-sm py-2 px-6">
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Report an issue</h3>
                <p className="text-sm text-gray-500 mt-0.5 truncate max-w-xs">{dishName}</p>
              </div>
              <button type="button" onClick={onClose} className="btn-ghost p-2 -mr-2 -mt-2 text-gray-400">
                ✕
              </button>
            </div>

            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-gray-700 mb-2">What&apos;s wrong?</legend>
              <div className="space-y-2">
                {REPORT_ISSUE_TYPES.map((issue) => (
                  <label key={issue.value} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="issueType"
                      value={issue.value}
                      checked={issueType === issue.value}
                      onChange={() => setIssueType(issue.value)}
                      className="mt-0.5 accent-picky-600"
                    />
                    <span className="text-sm text-gray-700">{issue.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mb-4">
              <label htmlFor="report-notes" className="text-sm font-medium text-gray-700 block mb-1">
                Additional details <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                id="report-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. The dressing contains anchovies"
                rows={3}
                maxLength={500}
                className="input-url resize-none text-sm"
              />
            </div>

            {state === 'error' && (
              <p className="text-sm text-red-500 mb-3">Something went wrong. Please try again.</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!issueType || state === 'submitting'}
                className="btn-primary flex-1 text-sm py-2"
              >
                {state === 'submitting' ? 'Submitting...' : 'Submit report'}
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
