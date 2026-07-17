'use client';

import { useState } from 'react';
import type { Dish } from '@/types';
import DietaryBadge from './DietaryBadge';
import ReportModal from './ReportModal';
import { capture } from '@/lib/posthog-client';
import { CONFIDENCE_THRESHOLD_WARNING } from '@/lib/dietary-config';
import { AlertIcon, QuestionIcon, FlagIcon } from './icons';

interface Props {
  dish: Dish;
  activeFilter?: string | null;
}

function confidenceTier(confidence: number): 'High' | 'Medium' | 'Low' {
  if (confidence >= 0.8) return 'High';
  if (confidence >= CONFIDENCE_THRESHOLD_WARNING) return 'Medium';
  return 'Low';
}

// Shows the confidence tier as visible text, not just a hover title — a dot
// meter that only differs by fill color communicates nothing on a touch
// device (no hover) or to anyone who can't distinguish the fill shades.
function ConfidenceDots({ confidence }: { confidence: number }) {
  const filled = Math.round(confidence * 5);
  const tier = confidenceTier(confidence);
  return (
    <div
      className="flex items-center gap-1.5"
      role="img"
      aria-label={`${tier} confidence, ${Math.round(confidence * 100)} percent`}
    >
      <div className="flex gap-0.5 items-center" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${i < filled ? 'bg-picky-500' : 'bg-mint-200'}`}
          />
        ))}
      </div>
      <span className="text-[10px] font-mono uppercase tracking-wide text-evergreen/80" aria-hidden="true">
        {tier}
      </span>
    </div>
  );
}

export default function DishCard({ dish, activeFilter }: Props) {
  const [reportOpen, setReportOpen] = useState(false);

  const isLowConfidence = dish.confidence < CONFIDENCE_THRESHOLD_WARNING;

  // Hide dishes that don't match the active filter (if set)
  if (activeFilter && activeFilter !== 'all') {
    if (activeFilter === 'vegan' && dish.classification !== 'vegan') return null;
    if (activeFilter === 'vegetarian' && dish.classification !== 'vegan' && dish.classification !== 'vegetarian') return null;
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
              {dish.price && (
                <span className="text-sm text-evergreen/80 flex-shrink-0">{dish.price}</span>
              )}
            </div>
            {dish.description && (
              <p className="text-xs text-evergreen/80 mt-1 leading-relaxed line-clamp-2">
                {dish.description}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <DietaryBadge classification={dish.classification} size="sm" />
              <ConfidenceDots confidence={dish.confidence} />
              {dish.confidenceReason && (
                <span className="text-[11px] text-evergreen/80 italic hidden sm:inline">
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
