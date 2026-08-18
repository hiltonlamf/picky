'use client';

import { useState } from 'react';
import FeedbackModal from './FeedbackModal';
import { SITE_FEEDBACK_TYPES } from '@/lib/dietary-config';
import { capture } from '@/lib/posthog-client';

interface Props {
  /** 'cta' is the big liquid-pink button on the homepage; 'link' is the quiet
   *  footer entry point that appears on every page. */
  variant?: 'cta' | 'link';
  label?: string;
}

/**
 * Site-wide feedback. Not tied to a restaurant, so it posts with a null
 * restaurantId — /api/feedback already accepts that (guide feedback does the
 * same), which is why this needs no API or schema change.
 *
 * Deliberately not a floating button: the bottom-right corner is already taken
 * by the cookie banner and the NPS prompt.
 */
export default function SiteFeedbackButton({ variant = 'link', label }: Props) {
  const [open, setOpen] = useState(false);

  function openModal() {
    setOpen(true);
    capture('feedback_modal_opened', { source: 'site' });
  }

  return (
    <>
      {variant === 'cta' ? (
        <button onClick={openModal} className="btn-cta">
          {label ?? 'Share your feedback →'}
        </button>
      ) : (
        <button
          onClick={openModal}
          className="text-azalea-400 font-semibold hover:text-white transition-colors"
        >
          {label ?? 'Share feedback →'}
        </button>
      )}

      {open && (
        <FeedbackModal
          restaurantId={null}
          restaurantName={null}
          types={SITE_FEEDBACK_TYPES}
          title="Tell us what you think"
          subtitle="An idea, a restaurant we should add, something we got wrong — we read what comes in."
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
