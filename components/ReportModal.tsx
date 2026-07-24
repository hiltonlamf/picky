'use client';

import { useState } from 'react';
import { REPORT_ISSUE_TYPES, PROPOSED_CLASSIFICATION_OPTIONS } from '@/lib/dietary-config';
import type { DietaryClassification } from '@/types';
import { CheckIcon, CloseIcon } from './icons';

interface Props {
  dishId: string;
  dishName: string;
  onClose: () => void;
}

export default function ReportModal({ dishId, dishName, onClose }: Props) {
  const [issueType, setIssueType] = useState('');
  const [proposed, setProposed] = useState<DietaryClassification | ''>('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  // A reclassification report is only actionable if the user says what it should
  // be — that proposed label is what an admin accepts in one click.
  const needsProposed = issueType === 'wrong_classification';
  const canSubmit = !!issueType && (!needsProposed || !!proposed);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState('submitting');
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishId,
          issueType,
          notes,
          proposedClassification: needsProposed ? proposed : undefined,
        }),
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
            <h3 className="text-lg font-semibold text-evergreen mb-2">Thanks for flagging this!</h3>
            <p className="text-sm text-evergreen/80 mb-4">
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
                <h3 className="text-base font-semibold text-evergreen">Report an issue</h3>
                <p className="text-sm text-evergreen/80 mt-0.5 truncate max-w-xs">{dishName}</p>
              </div>
              <button type="button" onClick={onClose} className="btn-ghost p-2 -mr-2 -mt-2 text-evergreen/80">
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>

            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-evergreen/80 mb-2">What&apos;s wrong?</legend>
              <div className="space-y-2">
                {REPORT_ISSUE_TYPES.map((issue) => (
                  <label key={issue.value} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="issueType"
                      value={issue.value}
                      checked={issueType === issue.value}
                      onChange={() => { setIssueType(issue.value); setProposed(''); }}
                      className="mt-0.5 accent-picky-600"
                    />
                    <span className="text-sm text-evergreen/80">{issue.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {needsProposed && (
              <fieldset className="mb-4">
                <legend className="text-sm font-medium text-evergreen/80 mb-2">What should it be?</legend>
                <div className="flex flex-wrap gap-2">
                  {PROPOSED_CLASSIFICATION_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-center gap-1.5 cursor-pointer rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        proposed === opt.value
                          ? 'border-picky-600 bg-mint-100 text-evergreen'
                          : 'border-mint-200 text-evergreen/80 hover:bg-mint-100'
                      }`}
                    >
                      <input
                        type="radio"
                        name="proposedClassification"
                        value={opt.value}
                        checked={proposed === opt.value}
                        onChange={() => setProposed(opt.value)}
                        className="sr-only"
                      />
                      <span aria-hidden="true">{opt.emoji}</span>
                      {opt.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="mb-4">
              <label htmlFor="report-notes" className="text-sm font-medium text-evergreen/80 block mb-1">
                Additional details <span className="text-evergreen/80 font-normal">(optional)</span>
              </label>
              <textarea
                id="report-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. The dressing contains anchovies"
                rows={3}
                maxLength={500}
                className="input-url resize-none text-sm !rounded-2xl"
              />
            </div>

            {state === 'error' && (
              <p className="text-sm text-red-500 mb-3">Something went wrong. Please try again.</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!canSubmit || state === 'submitting'}
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
