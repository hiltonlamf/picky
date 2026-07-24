'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { analyzeSequentially, type AnalyzeProgress } from '../batchAnalyze';

const COUNTRIES = ['Netherlands', 'United Kingdom', 'Ireland'];

export default function NewGuideForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [urlsText, setUrlsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [runningCost, setRunningCost] = useState(0);
  const stopRef = useRef(false);

  const parseUrls = (text: string): string[] =>
    text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  async function handleCreate() {
    setError(null);
    const name = displayName.trim();
    if (!name) {
      setError('Give the guide a city name.');
      return;
    }
    const urls = parseUrls(urlsText);
    setBusy(true);
    stopRef.current = false;
    setRunningCost(0);

    try {
      // 1. Create the draft guide + rows (no AI yet).
      const res = await fetch('/api/admin/guides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name, country, urls }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not create the guide.');
        setBusy(false);
        return;
      }

      const slug: string = data.guide.slug;
      // 2. Analyze the fresh rows one at a time, showing progress.
      const toAnalyze: string[] = (data.added ?? [])
        .filter((a: { needsAnalysis?: boolean; restaurantId?: string }) => a.needsAnalysis && a.restaurantId)
        .map((a: { restaurantId: string }) => a.restaurantId);

      if (toAnalyze.length > 0) {
        await analyzeSequentially(
          toAnalyze,
          (p) => {
            setProgress(p);
            if (p.phase === 'result' && typeof p.costUsd === 'number') {
              setRunningCost((c) => c + (p.costUsd ?? 0));
            }
          },
          () => stopRef.current
        );
      }

      // 3. Go to the workspace to review.
      router.push(`/admin/guides/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-evergreen mb-1">City name</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Amsterdam"
          disabled={busy}
          className="w-full rounded-xl border border-mint-200 px-4 py-2.5 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-evergreen mb-1">Country</label>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          disabled={busy}
          className="w-full rounded-xl border border-mint-200 px-4 py-2.5 text-sm bg-white"
        >
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-evergreen mb-1">
          Restaurant websites <span className="text-evergreen/50 font-normal">(one per line)</span>
        </label>
        <textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder={'https://restaurantblauw.nl\nhttps://csnoord.com\nhttps://ramen-ya.nl'}
          rows={10}
          disabled={busy}
          className="w-full rounded-xl border border-mint-200 px-4 py-3 text-sm font-mono"
        />
        <p className="text-xs text-evergreen/60 mt-1">
          Our AI reads each site one at a time — this can take a minute or two per restaurant and
          costs a small amount in AI usage. You can review, edit and add more later.
        </p>
      </div>

      {error && (
        <div className="card p-3 border border-sun-300 bg-sun-50 text-sm text-sun-800">{error}</div>
      )}

      {busy && progress && (
        <div className="card p-4 bg-mint-50" role="status" aria-live="polite">
          <p className="text-sm font-medium text-evergreen">
            Analyzing restaurant {progress.index} of {progress.total}&hellip;
          </p>
          <p className="text-xs text-evergreen/70 mt-1">
            {progress.total - progress.index} still queued · running AI cost so far: ${runningCost.toFixed(3)}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={handleCreate} disabled={busy} className="btn-primary text-sm disabled:opacity-50">
          {busy ? 'Working…' : 'Create guide & analyze'}
        </button>
        {busy && (
          <button
            onClick={() => {
              stopRef.current = true;
            }}
            className="btn-ghost text-sm"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
