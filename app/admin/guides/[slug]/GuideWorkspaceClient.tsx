'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { analyzeSequentially, type AnalyzeProgress } from '../batchAnalyze';
import { applyProgress, settleLive, startLive, statusBadge, type LiveState } from '../statusBadge';

export interface WorkspaceRestaurant {
  id: string;
  name: string | null;
  url: string;
  status: string;
  dishCount: number;
  menuLanguage: string | null;
  hidden: boolean;
  publiclyVisible: boolean;
  heldBackReason: string | null;
}

interface GuideMeta {
  slug: string;
  displayName: string;
  country: string | null;
  status: 'draft' | 'published';
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
}

export default function GuideWorkspaceClient({
  guide,
  restaurants,
}: {
  guide: GuideMeta;
  restaurants: WorkspaceRestaurant[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addText, setAddText] = useState('');
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [runningCost, setRunningCost] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const stopRef = useRef(false);

  const visible = restaurants.filter((r) => r.publiclyVisible);
  const needsAttention = restaurants.filter((r) => !r.hidden && !r.publiclyVisible);
  const hidden = restaurants.filter((r) => r.hidden);
  const pendingIds = restaurants
    .filter((r) => r.status === 'pending' || r.status === 'processing')
    .map((r) => r.id);
  // Restaurants that already ran but came back empty or errored. These are NOT
  // picked up by "Analyze queued" (they're no longer pending) and re-pasting
  // their URL won't re-run them either, so a batch that failed — e.g. because
  // the page-reader was rate-limited — would otherwise be stuck. This lets an
  // admin re-run them all in one click (e.g. after adding a reader API key).
  const failedIds = restaurants
    .filter((r) => r.status === 'no_menu' || r.status === 'error')
    .map((r) => r.id);

  async function run(key: string, fn: () => Promise<void>) {
    setError(null);
    setBusyKey(key);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusyKey(null);
    }
  }

  async function runAnalyze(ids: string[]) {
    if (ids.length === 0) return;
    setError(null);
    setAnalyzing(true);
    setRunningCost(0);
    // Everything in this batch starts as "Queued"; each restaurant then moves to
    // "Analyzing" and finally to its outcome as the run walks through them.
    setLive(startLive(ids));
    stopRef.current = false;
    try {
      await analyzeSequentially(
        ids,
        (p) => {
          setProgress(p);
          setLive((prev) => applyProgress(prev, p));
          if (p.phase === 'result' && typeof p.costUsd === 'number') {
            setRunningCost((c) => c + (p.costUsd ?? 0));
          }
        },
        () => stopRef.current
      );
    } finally {
      setAnalyzing(false);
      setProgress(null);
      setLive(settleLive);
      router.refresh();
    }
  }

  async function handleAdd() {
    const urls = addText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) return;
    setError(null);
    setBusyKey('add');
    try {
      const res = await fetch(`/api/admin/guides/${guide.slug}/restaurants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not add restaurants');
      setAddText('');
      setBusyKey(null);
      const toAnalyze: string[] = (data.added ?? [])
        .filter((a: { needsAnalysis?: boolean; restaurantId?: string }) => a.needsAnalysis && a.restaurantId)
        .map((a: { restaurantId: string }) => a.restaurantId);
      router.refresh();
      await runAnalyze(toAnalyze);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add restaurants');
      setBusyKey(null);
    }
  }

  const anyBusy = busyKey !== null || analyzing;
  const published = guide.status === 'published';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/admin/guides" className="text-sm text-evergreen/70 hover:underline">
            ← All guides
          </Link>
          <h1 className="text-xl font-bold text-evergreen mt-1">
            {guide.displayName}
            {guide.country && <span className="text-evergreen/50 font-normal"> · {guide.country}</span>}
            <span
              className={`ml-3 align-middle text-xs font-mono uppercase px-2 py-1 rounded-full ${
                published ? 'bg-mint-100 text-picky-700' : 'bg-sun-50 text-sun-800'
              }`}
            >
              {published ? 'Live' : 'Draft'}
            </span>
          </h1>
          <p className="text-sm text-evergreen/70 mt-1">
            <span className="text-picky-700 font-medium">{visible.length} will be live</span>
            {needsAttention.length > 0 && (
              <span className="text-sun-800 font-medium"> · {needsAttention.length} need attention</span>
            )}
            {hidden.length > 0 && <span className="text-evergreen/50"> · {hidden.length} hidden</span>}
            <span className="text-evergreen/50"> · {restaurants.length} total</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/${guide.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-sm"
          >
            {published ? 'View live' : 'Preview'} ↗
          </a>
          {published ? (
            <button
              onClick={() => run('unpublish', () => postJson(`/api/admin/guides/${guide.slug}/publish`, { published: false }))}
              disabled={anyBusy}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              Unpublish
            </button>
          ) : (
            <button
              onClick={() => {
                if (
                  confirm(
                    `Publish the ${guide.displayName} guide? ${visible.length} restaurant${
                      visible.length === 1 ? '' : 's'
                    } will go live immediately${
                      needsAttention.length ? `, and ${needsAttention.length} will stay hidden until fixed.` : '.'
                    }`
                  )
                ) {
                  run('publish', () => postJson(`/api/admin/guides/${guide.slug}/publish`, { published: true }));
                }
              }}
              disabled={anyBusy || visible.length === 0}
              className="btn-primary text-sm disabled:opacity-50"
              title={visible.length === 0 ? 'No restaurants are ready to publish yet' : undefined}
            >
              Publish guide
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="card p-3 border border-sun-300 bg-sun-50 text-sm text-sun-800">{error}</div>
      )}

      {/* Add restaurants */}
      <div className="card p-4">
        <label className="block text-sm font-semibold text-evergreen mb-1">
          Add restaurants <span className="text-evergreen/50 font-normal">(one website per line)</span>
        </label>
        <textarea
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          placeholder={'https://sojubar.com\nhttps://fulumandarijn.com'}
          rows={4}
          disabled={anyBusy}
          className="w-full rounded-xl border border-mint-200 px-4 py-3 text-sm font-mono"
        />
        <div className="flex items-center gap-3 mt-2">
          <button onClick={handleAdd} disabled={anyBusy || !addText.trim()} className="btn-primary text-sm disabled:opacity-50">
            {busyKey === 'add' ? 'Adding…' : 'Add & analyze'}
          </button>
          {pendingIds.length > 0 && !analyzing && (
            <button onClick={() => runAnalyze(pendingIds)} disabled={anyBusy} className="btn-secondary text-sm">
              Analyze {pendingIds.length} queued
            </button>
          )}
          {failedIds.length > 0 && !analyzing && (
            <button
              onClick={() => runAnalyze(failedIds)}
              disabled={anyBusy}
              className="btn-secondary text-sm"
              title="Re-run the restaurants that came back with no menu or an error"
            >
              Retry {failedIds.length} failed
            </button>
          )}
        </div>
      </div>

      {/* Analyze progress */}
      {analyzing && progress && (
        <div className="card p-4 bg-mint-50 flex items-center justify-between gap-4" role="status" aria-live="polite">
          <div>
            <p className="text-sm font-medium text-evergreen">
              Analyzing restaurant {progress.index} of {progress.total}&hellip;
            </p>
            <p className="text-xs text-evergreen/70 mt-1">
              {progress.total - progress.index} still queued · running AI cost so far: ${runningCost.toFixed(3)}
            </p>
          </div>
          <button onClick={() => (stopRef.current = true)} className="btn-ghost text-sm">
            Stop
          </button>
        </div>
      )}

      {/* Needs attention */}
      {needsAttention.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-sun-800 mb-2">
            ⚠ Needs attention ({needsAttention.length}) — held back from the public guide
          </h2>
          <div className="card divide-y divide-mint-100 border border-sun-200">
            {needsAttention.map((r) => (
              <RestaurantRow
                key={r.id}
                r={r}
                guide={guide}
                run={run}
                busyKey={busyKey}
                anyBusy={anyBusy}
                live={live[r.id]}
                highlight
              />
            ))}
          </div>
        </div>
      )}

      {/* All restaurants */}
      <div>
        <h2 className="text-sm font-semibold text-evergreen mb-2">All restaurants ({restaurants.length})</h2>
        {restaurants.length === 0 ? (
          <div className="card p-6 text-center text-evergreen/60 text-sm">
            No restaurants yet — add some above.
          </div>
        ) : (
          <div className="card divide-y divide-mint-100">
            {restaurants.map((r) => (
              <RestaurantRow
                key={r.id}
                r={r}
                guide={guide}
                run={run}
                busyKey={busyKey}
                anyBusy={anyBusy}
                live={live[r.id]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RestaurantRow({
  r,
  guide,
  run,
  busyKey,
  anyBusy,
  live,
  highlight,
}: {
  r: WorkspaceRestaurant;
  guide: GuideMeta;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  busyKey: string | null;
  anyBusy: boolean;
  live?: LiveState;
  highlight?: boolean;
}) {
  const badge = statusBadge(r.status, live);
  const dishCount = live?.phase === 'result' && typeof live.dishCount === 'number' ? live.dishCount : r.dishCount;
  return (
    <div className={`flex items-center justify-between gap-3 p-4 ${highlight ? 'bg-sun-50/40' : ''}`}>
      <div className="min-w-0">
        <p className="font-semibold text-evergreen truncate">
          {r.name ?? r.url.replace(/^https?:\/\//, '')}
          {r.publiclyVisible && (
            <span className="ml-2 text-xs font-medium text-picky-700 bg-mint-100 rounded-full px-2 py-0.5 align-middle">
              live
            </span>
          )}
          {r.hidden && (
            <span className="ml-2 text-xs font-medium text-evergreen/60 bg-mint-100 rounded-full px-2 py-0.5 align-middle">
              hidden
            </span>
          )}
          {r.menuLanguage && r.menuLanguage.toLowerCase() !== 'english' && (
            <span className="ml-2 text-xs font-medium text-evergreen/70 bg-mint-50 rounded-full px-2 py-0.5 align-middle">
              {r.menuLanguage}
            </span>
          )}
        </p>
        <p className="text-xs text-evergreen/70 truncate">
          {dishCount} dish{dishCount === 1 ? '' : 'es'} · {r.url.replace(/^https?:\/\//, '')}
        </p>
        {r.heldBackReason && <p className="text-xs text-sun-800 mt-0.5">⚠ {r.heldBackReason}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-mono uppercase px-2 py-1 rounded-full ${badge.className}`}
          title={badge.title}
        >
          {badge.active && (
            <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
          )}
          {badge.label}
        </span>
        <Link href={`/admin/restaurants/${r.id}/review`} className="btn-ghost text-xs px-3 py-1.5">
          Review
        </Link>
        <button
          onClick={() =>
            run(`hide-${r.id}`, () =>
              postJson(`/api/admin/guides/${guide.slug}/hide`, { restaurantId: r.id, hidden: !r.hidden })
            )
          }
          disabled={anyBusy}
          className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-50"
        >
          {busyKey === `hide-${r.id}` ? '…' : r.hidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          onClick={() => {
            if (confirm(`Remove ${r.name ?? 'this restaurant'} from the ${guide.displayName} guide?`)) {
              run(`remove-${r.id}`, () =>
                postJson(`/api/admin/restaurants/${r.id}/guide`, { city: guide.slug, featured: false })
              );
            }
          }}
          disabled={anyBusy}
          className="btn-ghost text-xs px-3 py-1.5 text-sun-800 disabled:opacity-50"
        >
          {busyKey === `remove-${r.id}` ? '…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}
