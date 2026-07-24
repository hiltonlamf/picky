'use client';

import { useState } from 'react';
import { GENERAL_FEEDBACK_TYPES, PROPOSED_CLASSIFICATION_OPTIONS } from '@/lib/dietary-config';
import type { DietaryClassification } from '@/types';
import { CheckIcon, CloseIcon } from './icons';

interface Props {
  /** null for site-level feedback, which isn't tied to a restaurant. */
  restaurantId: string | null;
  restaurantName: string | null;
  onClose: () => void;
  /** Defaults to the per-restaurant list; the footer passes SITE_FEEDBACK_TYPES. */
  types?: { value: string; label: string }[];
  title?: string;
  subtitle?: string;
  /** The restaurant's menu labels — lets a "not a menu" / menu report say which
   *  menu it's about. Empty for single-menu restaurants and site/guide feedback. */
  menuLabels?: string[];
  /** The menu the user is currently viewing (prefills the which-menu picker). */
  currentMenuLabel?: string | null;
}

const NOTES_PLACEHOLDER: Record<string, string> = {
  not_a_menu: "e.g. This is the drinks list / an About page — it isn't a food menu",
  missing_menu: 'e.g. The dinner menu is missing — I only see lunch',
  menu_no_dishes: 'e.g. The menu is there but almost all the dishes are missing',
  missing_dish: 'e.g. Falafel wrap — I saw it on the menu but it\'s not in the results',
  wrong_name: 'e.g. Any extra detail about the name',
  wrong_menu: 'e.g. This looks like the lunch menu, but I was checking dinner',
  feature_request: "e.g. A filter for gluten-free dishes would be amazing",
  idea: 'e.g. I would love a filter for gluten-free dishes',
  restaurant_request: 'e.g. Add Fia in Rathgar — great veggie brunch',
  something_wrong: 'e.g. The dish list for X looks like the wrong menu',
  other: 'Tell us more (optional)',
};

// Types that are about one specific menu, so we ask which one.
const MENU_SPECIFIC = new Set(['not_a_menu', 'menu_no_dishes', 'menu_outdated']);

export default function FeedbackModal({
  restaurantId,
  restaurantName,
  onClose,
  types = GENERAL_FEEDBACK_TYPES,
  title = 'Share feedback',
  subtitle = 'Missing dish, wrong menu, feature idea — anything goes.',
  menuLabels = [],
  currentMenuLabel = null,
}: Props) {
  const [feedbackType, setFeedbackType] = useState('');
  const [notes, setNotes] = useState('');
  const [proposedDishName, setProposedDishName] = useState('');
  const [proposedLabel, setProposedLabel] = useState<DietaryClassification | ''>('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [proposedName, setProposedName] = useState('');
  const [menuLabel, setMenuLabel] = useState<string>(currentMenuLabel ?? '');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  const showDishName = feedbackType === 'missing_dish';
  const showReferenceUrl = feedbackType === 'missing_menu';
  const showCorrectName = feedbackType === 'wrong_name';
  const showMenuPicker = MENU_SPECIFIC.has(feedbackType) && menuLabels.length > 1;

  // Deterministic reports need their key field before they're actionable.
  const canSubmit =
    !!feedbackType &&
    (!showDishName || !!proposedDishName.trim()) &&
    (!showCorrectName || !!proposedName.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState('submitting');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId,
          restaurantName,
          feedbackType,
          notes,
          proposedDishName: showDishName ? proposedDishName.trim() : undefined,
          proposedClassification: showDishName && proposedLabel ? proposedLabel : undefined,
          referenceUrl: showReferenceUrl ? referenceUrl.trim() : undefined,
          proposedName: showCorrectName ? proposedName.trim() : undefined,
          menuLabel: MENU_SPECIFIC.has(feedbackType) ? (menuLabel || currentMenuLabel || null) : undefined,
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
                <h3 className="text-base font-semibold text-evergreen">{title}</h3>
                <p className="text-sm text-evergreen/80 mt-0.5">{subtitle}</p>
              </div>
              <button type="button" onClick={onClose} className="btn-ghost p-2 -mr-2 -mt-2 text-evergreen/80">
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>

            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-evergreen/80 mb-2">What&apos;s this about?</legend>
              <div className="space-y-2">
                {types.map((issue) => (
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

            {showMenuPicker && (
              <div className="mb-4">
                <label htmlFor="feedback-menu" className="text-sm font-medium text-evergreen/80 block mb-1">
                  Which menu?
                </label>
                <select
                  id="feedback-menu"
                  value={menuLabel}
                  onChange={(e) => setMenuLabel(e.target.value)}
                  className="input-url text-sm !rounded-2xl"
                >
                  {menuLabels.map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
              </div>
            )}

            {showDishName && (
              <div className="mb-4">
                <label htmlFor="feedback-dish" className="text-sm font-medium text-evergreen/80 block mb-1">
                  Which dish is missing?
                </label>
                <input
                  id="feedback-dish"
                  type="text"
                  value={proposedDishName}
                  onChange={(e) => setProposedDishName(e.target.value)}
                  placeholder="e.g. Falafel wrap"
                  maxLength={200}
                  className="input-url text-sm !rounded-2xl"
                />
                <div className="mt-2">
                  <p className="text-xs text-evergreen/70 mb-1.5">Is it veggie? (optional)</p>
                  <div className="flex flex-wrap gap-2">
                    {PROPOSED_CLASSIFICATION_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-center gap-1.5 cursor-pointer rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          proposedLabel === opt.value
                            ? 'border-picky-600 bg-mint-100 text-evergreen'
                            : 'border-mint-200 text-evergreen/80 hover:bg-mint-100'
                        }`}
                      >
                        <input
                          type="radio"
                          name="proposedLabel"
                          value={opt.value}
                          checked={proposedLabel === opt.value}
                          onChange={() => setProposedLabel(opt.value)}
                          className="sr-only"
                        />
                        <span aria-hidden="true">{opt.emoji}</span>
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {showReferenceUrl && (
              <div className="mb-4">
                <label htmlFor="feedback-url" className="text-sm font-medium text-evergreen/80 block mb-1">
                  Link to the missing menu <span className="font-normal text-evergreen/70">(a page, PDF or photo helps a lot)</span>
                </label>
                <input
                  id="feedback-url"
                  type="url"
                  value={referenceUrl}
                  onChange={(e) => setReferenceUrl(e.target.value)}
                  placeholder="https://…"
                  maxLength={500}
                  className="input-url text-sm !rounded-2xl"
                />
              </div>
            )}

            {showCorrectName && (
              <div className="mb-4">
                <label htmlFor="feedback-name" className="text-sm font-medium text-evergreen/80 block mb-1">
                  What&apos;s the correct name?
                </label>
                <input
                  id="feedback-name"
                  type="text"
                  value={proposedName}
                  onChange={(e) => setProposedName(e.target.value)}
                  placeholder="e.g. Cornucopia"
                  maxLength={200}
                  className="input-url text-sm !rounded-2xl"
                />
              </div>
            )}

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
                disabled={!canSubmit || state === 'submitting'}
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
