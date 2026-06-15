'use client';

import { useState } from 'react';
import type { Dish } from '@/types';
import DietaryBadge from './DietaryBadge';
import ReportModal from './ReportModal';
import { CONFIDENCE_THRESHOLD_WARNING } from '@/lib/dietary-config';

interface Props {
  dish: Dish;
  activeFilter?: string | null;
}

function ConfidenceDots({ confidence }: { confidence: number }) {
  const filled = Math.round(confidence * 5);
  return (
    <div className="flex gap-0.5 items-center" title={`Confidence: ${Math.round(confidence * 100)}%`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < filled ? 'bg-picky-500' : 'bg-gray-200'}`}
        />
      ))}
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
          dish.warningFlagged ? 'border-amber-300 bg-amber-50/30' : ''
        }`}
      >
        {dish.warningFlagged && (
          <div className="flex items-center gap-2 text-amber-700 text-xs font-medium mb-2 bg-amber-100 rounded-lg px-2.5 py-1.5">
            <span aria-hidden="true">⚠️</span>
            This dish has been flagged by users — confirm with the restaurant
          </div>
        )}

        {isLowConfidence && !dish.warningFlagged && (
          <div className="flex items-center gap-2 text-amber-700 text-xs font-medium mb-2 bg-amber-50 rounded-lg px-2.5 py-1.5 border border-amber-200">
            <span aria-hidden="true">❓</span>
            Uncertain — please confirm with the restaurant
          </div>
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-900 leading-tight">{dish.name}</h3>
              {dish.price && (
                <span className="text-sm text-gray-500 flex-shrink-0">{dish.price}</span>
              )}
            </div>
            {dish.description && (
              <p className="text-xs text-gray-500 mt-1 leading-relaxed line-clamp-2">
                {dish.description}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <DietaryBadge classification={dish.classification} size="sm" />
              <ConfidenceDots confidence={dish.confidence} />
              {dish.confidenceReason && (
                <span className="text-[11px] text-gray-400 italic hidden sm:inline">
                  {dish.confidenceReason}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => setReportOpen(true)}
            className="flex-shrink-0 text-gray-300 hover:text-amber-500 transition-colors p-1.5 -mr-1 -mt-1 rounded-lg hover:bg-amber-50"
            aria-label={`Report issue with ${dish.name}`}
            title="Report incorrect label"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
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
