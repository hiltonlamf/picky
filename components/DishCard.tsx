'use client';

import { useState } from 'react';
import type { Dish } from '@/types';
import DietaryBadge from './DietaryBadge';
import ReportModal from './ReportModal';
import { capture } from '@/lib/posthog-client';
import { CONFIDENCE_THRESHOLD_WARNING } from '@/lib/dietary-config';
import { formatPrice } from '@/lib/format-price';
import { AlertIcon, QuestionIcon, FlagIcon } from './icons';

interface Props {
  dish: Dish;
  activeFilter?: string | null;
  /** A side, sauce or sweet — shown, but not part of the headline count. */
  aside?: boolean;
}

export default function DishCard({ dish, activeFilter, aside }: Props) {
  const [reportOpen, setReportOpen] = useState(false);

  const isLowConfidence = dish.confidence < CONFIDENCE_THRESHOLD_WARNING;
  // Why we hedged, shown ONLY when we actually hedged. A confidence meter on
  // every dish told the diner nothing they could act on ("HIGH" next to a dish
  // they were going to eat anyway); what they need is the reason, on the dish
  // where the answer is genuinely unclear.
  const uncertain = isLowConfidence || dish.classification === 'unknown';
  // Menus often list a bare "4"; without a symbol it doesn't read as a price.
  const price = formatPrice(dish.price);

  // Hide dishes that don't match the active filter (if set). 'unknown'
  // dishes are included under vegetarian (a "maybe, please confirm" option)
  // but never under vegan — the higher-trust claim per CLAUDE.md.
  if (activeFilter && activeFilter !== 'all') {
    if (activeFilter === 'vegan' && dish.classification !== 'vegan') return null;
    if (
      activeFilter === 'vegetarian' &&
      dish.classification !== 'vegan' &&
      dish.classification !== 'vegetarian' &&
      dish.classification !== 'unknown'
    )
      return null;
  }

  return (
    <>
      <div
        className={`card p-4 animate-fade-in ${
          dish.warningFlagged ? 'border-sun-400/50 bg-sun-50/30' : ''
        }`}
      >
        {dish.warningFlagged && (
          <div className="flex items-center gap-2 text-sun-800 text-xs font-medium mb-2 bg-sun-50 rounded-lg px-2.5 py-1.5">
            <AlertIcon className="w-3.5 h-3.5 flex-shrink-0" />
            This dish has been flagged by users — confirm with the restaurant
          </div>
        )}

        {isLowConfidence && !dish.warningFlagged && (
          <div className="flex items-center gap-2 text-sun-800 text-xs font-medium mb-2 bg-sun-50/60 rounded-lg px-2.5 py-1.5 border border-sun-400/30">
            <QuestionIcon className="w-3.5 h-3.5 flex-shrink-0" />
            Uncertain — please confirm with the restaurant
          </div>
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-evergreen leading-tight">{dish.name}</h3>
              {price && (
                <span className="text-sm font-semibold text-forest/75 flex-shrink-0 tabular-nums">
                  {price}
                </span>
              )}
            </div>
            {dish.description && (
              <p className="text-xs text-evergreen/80 mt-1 leading-relaxed line-clamp-2">
                {dish.description}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <DietaryBadge classification={dish.classification} size="sm" />
              {/* Says which dishes the "N veggie" number is counting. Without
                  it the tab reads "4" above nine rows with nothing to explain
                  the difference. */}
              {aside && (
                <span className="text-[11px] text-evergreen/80 italic">
                  Not included in the veggie count
                </span>
              )}
              {uncertain && dish.confidenceReason && (
                <span className="text-[11px] text-evergreen/80 italic">
                  {/* Both notes are small italics, so a dish that is an aside
                      AND uncertain would otherwise read as one run-on line. */}
                  {aside && <span aria-hidden="true" className="mr-1.5">·</span>}
                  {dish.confidenceReason}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => { setReportOpen(true); capture('report_modal_opened', { dish_id: dish.id, classification: dish.classification }); }}
            className="flex-shrink-0 text-evergreen/80 hover:text-sun-400 transition-colors p-1.5 -mr-1 -mt-1 rounded-lg hover:bg-sun-50"
            aria-label={`Report issue with ${dish.name}`}
            title="Report incorrect label"
          >
            <FlagIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {reportOpen && (
        <ReportModal
          dishId={dish.id}
          dishName={dish.name}
          onClose={() => setReportOpen(false)}
        />
      )}
    </>
  );
}
