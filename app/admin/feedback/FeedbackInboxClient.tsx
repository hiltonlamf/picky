'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FeedbackItem } from '@/types';
import { REPORT_ISSUE_TYPES, GENERAL_FEEDBACK_TYPES } from '@/lib/dietary-config';

const ISSUE_LABELS: Record<string, string> = Object.fromEntries(
  [...REPORT_ISSUE_TYPES, ...GENERAL_FEEDBACK_TYPES].map((t) => [t.value, t.label])
);

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

  async function resolve(item: FeedbackItem, status: 'confirmed' | 'dismissed') {
    setBusyId(item.id);
    setError(null);
    try {
      await postResolve({ kind: item.kind, id: item.id, status, resolutionNotes: notesById[item.id] ?? '' });
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
        For each report: <strong>Open the restaurant</strong> to make any fixes, then resolve it —{' '}
        <strong>Confirm</strong> if the user was right, <strong>Dismiss</strong> if not. You can add a resolution note
        either way.
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
                {item.notes && <p className="text-sm text-evergreen mt-2 italic">&ldquo;{item.notes}&rdquo;</p>}
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

            {item.status === 'open' && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  placeholder="Resolution note (optional)"
                  value={notesById[item.id] ?? ''}
                  onChange={(e) => setNotesById((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  className="flex-1 min-w-[180px] rounded-full border border-mint-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-picky-500"
                />
                <button disabled={busyId === item.id} onClick={() => resolve(item, 'confirmed')} className="btn-secondary text-sm px-4 py-1.5">
                  Confirm (user was right)
                </button>
                <button disabled={busyId === item.id} onClick={() => resolve(item, 'dismissed')} className="btn-ghost text-sm">
                  Dismiss
                </button>
              </div>
            )}
            {item.status !== 'open' && item.resolutionNotes && (
              <p className="text-xs text-evergreen/80 mt-2">Resolution: {item.resolutionNotes}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
