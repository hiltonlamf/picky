'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FeedbackItem } from '@/types';
import {
  REPORT_ISSUE_TYPES,
  GENERAL_FEEDBACK_TYPES,
  GUIDE_FEEDBACK_TYPES,
  SITE_FEEDBACK_TYPES,
  FEEDBACK_RESOLUTION,
  PROPOSED_CLASSIFICATION_OPTIONS,
  type FeedbackResolveAction,
} from '@/lib/dietary-config';

const ISSUE_LABELS: Record<string, string> = Object.fromEntries(
  [...REPORT_ISSUE_TYPES, ...GENERAL_FEEDBACK_TYPES, ...GUIDE_FEEDBACK_TYPES, ...SITE_FEEDBACK_TYPES].map(
    (t) => [t.value, t.label]
  )
);

const PROPOSED_LABELS: Record<string, string> = Object.fromEntries(
  PROPOSED_CLASSIFICATION_OPTIONS.map((o) => [o.value, `${o.emoji} ${o.label}`])
);

// Button copy per resolution action, so the admin sees exactly what Accept does.
const ACCEPT_LABEL: Record<FeedbackResolveAction, string> = {
  reclassify: 'Accept & apply',
  remove_dish: 'Accept & remove',
  remove_menu: 'Accept & remove menu',
  rename: 'Accept & rename',
  reparse: 'Accept & reparse',
  route: 'Accept & open review',
};

function FilterTab({ label, value, active }: { label: string; value: string; active: string }) {
  return (
    <Link
      href={`/admin/feedback?status=${value}`}
      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active === value ? 'bg-evergreen text-lime' : 'text-evergreen/80 hover:bg-mint-100'
      }`}
    >
      {label}
    </Link>
  );
}

function statusBadgeClass(status: string): string {
  if (status === 'open') return 'bg-sun-50 text-sun-800';
  if (status === 'confirmed') return 'bg-mint-100 text-picky-700';
  return 'bg-mint-100 text-evergreen/80';
}

async function postResolve(body: unknown) {
  const res = await fetch('/api/admin/feedback-resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

export default function FeedbackInboxClient({ items, activeStatus }: { items: FeedbackItem[]; activeStatus: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function reject(item: FeedbackItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await postResolve({ kind: item.kind, id: item.id, status: 'dismissed', resolutionNotes: notesById[item.id] ?? '' });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — the change was not saved.');
    } finally {
      setBusyId(null);
    }
  }

  async function accept(item: FeedbackItem, action: FeedbackResolveAction) {
    setBusyId(item.id);
    setError(null);
    try {
      // Reparse is the one AI-spend path — trigger it via its own route first,
      // then record the report as resolved. Everything else is applied by the
      // resolve engine itself.
      if (action === 'reparse' && item.restaurantId) {
        const res = await fetch(`/api/admin/restaurants/${item.restaurantId}/reparse`, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? 'Reparse failed');
        }
      }
      await postResolve({ kind: item.kind, id: item.id, status: 'confirmed', resolutionNotes: notesById[item.id] ?? '' });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — the change was not saved.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <span>
            <strong>Couldn&rsquo;t save that.</strong> {error}
          </span>
          <button onClick={() => setError(null)} className="text-red-700 font-bold flex-shrink-0" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 mb-3 flex-wrap">
        <FilterTab label="Open" value="open" active={activeStatus} />
        <FilterTab label="Confirmed" value="confirmed" active={activeStatus} />
        <FilterTab label="Dismissed" value="dismissed" active={activeStatus} />
        <FilterTab label="All" value="all" active={activeStatus} />
      </div>
      <p className="text-sm text-evergreen/70 mb-6">
        <strong>Accept</strong> applies the user&rsquo;s fix directly — reclassify a dish, remove a not-a-dish or
        not-a-menu, rename a restaurant — and it goes live immediately. <strong>Reject</strong> dismisses it. Reports we
        can&rsquo;t auto-apply link you into the restaurant to fix by hand. A resolution note is optional either way.
      </p>

      {items.length === 0 && <p className="text-sm text-evergreen/80">Nothing here.</p>}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={`${item.kind}-${item.id}`} className="card p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="eyebrow mb-1">
                  {item.kind === 'dish_report' ? 'Dish report' : 'General feedback'} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </p>
                <p className="font-semibold text-evergreen">{ISSUE_LABELS[item.issueOrFeedbackType] ?? item.issueOrFeedbackType}</p>
                {item.dishName && <p className="text-sm text-evergreen/80">Dish: {item.dishName}</p>}
                {item.restaurantName && <p className="text-sm text-evergreen/80">Restaurant: {item.restaurantName}</p>}
                {!item.restaurantId && item.city && (
                  <p className="text-sm text-evergreen/80">
                    Guide: <span className="capitalize">{item.city}</span>
                  </p>
                )}
                {item.notes && <p className="text-sm text-evergreen mt-2 italic">&ldquo;{item.notes}&rdquo;</p>}
                <ProposalDetails item={item} />
              </div>
              <span className={`text-xs font-mono uppercase px-2 py-1 rounded-full flex-shrink-0 ${statusBadgeClass(item.status)}`}>
                {item.status}
              </span>
            </div>

            {item.restaurantId && (
              <a
                href={`/admin/restaurants/${item.restaurantId}/review${item.dishId ? `#dish-${item.dishId}` : ''}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-3 text-sm text-picky-700 hover:underline font-medium"
              >
                Open restaurant to edit ↗
              </a>
            )}

            {item.status === 'open' && (() => {
              const action: FeedbackResolveAction = FEEDBACK_RESOLUTION[item.issueOrFeedbackType] ?? 'route';
              // A reparse needs a restaurant to act on; without one, fall back to manual.
              const canReparse = action !== 'reparse' || !!item.restaurantId;
              return (
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    placeholder="Resolution note (optional)"
                    value={notesById[item.id] ?? ''}
                    onChange={(e) => setNotesById((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="flex-1 min-w-[180px] rounded-full border border-mint-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-picky-500"
                  />
                  <button
                    disabled={busyId === item.id || !canReparse}
                    onClick={() => accept(item, action)}
                    className="btn-secondary text-sm px-4 py-1.5"
                    title={action === 'reparse' ? 'Re-runs analysis — this spends AI credit' : undefined}
                  >
                    {busyId === item.id ? 'Working…' : ACCEPT_LABEL[action]}
                  </button>
                  <button disabled={busyId === item.id} onClick={() => reject(item)} className="btn-ghost text-sm">
                    Reject
                  </button>
                </div>
              );
            })()}
            {item.status !== 'open' && (item.resolutionAction || item.resolutionNotes) && (
              <p className="text-xs text-evergreen/80 mt-2">
                {item.resolutionAction && <span className="font-mono">{item.resolutionAction}</span>}
                {item.resolutionAction && item.resolutionNotes ? ' · ' : ''}
                {item.resolutionNotes}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// The deterministic part of a report: exactly what the user proposed, so the
// admin can see what Accept will do without opening anything.
function ProposalDetails({ item }: { item: FeedbackItem }) {
  const rows: React.ReactNode[] = [];

  if (item.proposedClassification) {
    // The trust-sensitive direction is making a dish look MORE veggie-friendly.
    const permissive = item.proposedClassification === 'vegan' || item.proposedClassification === 'vegetarian';
    rows.push(
      <span key="cls">
        Should be: <strong>{PROPOSED_LABELS[item.proposedClassification] ?? item.proposedClassification}</strong>
        {permissive && <span className="ml-1 text-sun-700" title="Makes this dish read as veggie — double-check before accepting">⚠️</span>}
      </span>
    );
  }
  if (item.proposedDishName) {
    rows.push(<span key="dish">Add dish: <strong>{item.proposedDishName}</strong></span>);
  }
  if (item.proposedName) {
    rows.push(<span key="name">Rename to: <strong>{item.proposedName}</strong></span>);
  }
  if (item.menuLabel) {
    rows.push(<span key="menu">Menu: <strong>{item.menuLabel}</strong></span>);
  }

  if (rows.length === 0 && !item.referenceUrl) return null;

  return (
    <div className="mt-2 text-sm text-evergreen/90 space-y-0.5">
      {rows.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      {item.referenceUrl && (
        <p>
          Menu link:{' '}
          <a href={item.referenceUrl} target="_blank" rel="noopener noreferrer" className="text-picky-700 hover:underline break-all">
            {item.referenceUrl} ↗
          </a>
        </p>
      )}
    </div>
  );
}
