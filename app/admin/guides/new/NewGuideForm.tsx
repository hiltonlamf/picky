'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const COUNTRIES = ['Netherlands', 'United Kingdom', 'Ireland'];

/**
 * Create a city guide and start analysing it.
 *
 * The analysis used to run in THIS component, restaurant by restaurant, which
 * meant seeding a 40-restaurant city held the admin on this page for half an
 * hour — and closing the tab stranded every restaurant it hadn't reached yet.
 * Now the guide is created, a server run is started, and we go straight to the
 * workspace, which reports progress read from the database. Same one click, no
 * vigil.
 */
export default function NewGuideForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [urlsText, setUrlsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the guide was created but the run could not be started — the guide
  // is real and must not be left looking like a failure.
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const parseUrls = (text: string): string[] =>
    text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  async function handleCreate() {
    setError(null);
    setCreatedSlug(null);
    const name = displayName.trim();
    if (!name) {
      setError('Give the guide a city name.');
      return;
    }
    const urls = parseUrls(urlsText);
    setBusy(true);

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
      const needsAnalysis: number = (data.added ?? []).filter(
        (a: { needsAnalysis?: boolean; restaurantId?: string }) => a.needsAnalysis && a.restaurantId
      ).length;

      // 2. Hand the batch to a server, which will keep going without this tab.
      if (needsAnalysis > 0) {
        const started = await fetch(`/api/admin/guides/${slug}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'queued' }),
        });
        if (!started.ok) {
          const detail = await started.json().catch(() => ({}));
          setCreatedSlug(slug);
          setError(
            `The ${name} guide was created, but the analysis run could not be started: ${
              detail.error ?? `error ${started.status}`
            }`
          );
          setBusy(false);
          return;
        }
      }

      // 3. Go to the workspace, which shows the run's progress live.
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
          Our AI reads each site one at a time, on a server — a minute or two per restaurant, and a
          small amount in AI usage. You&rsquo;ll land on the guide workspace and can watch it happen,
          close the tab, or come back later. You can review, edit and add more at any point.
        </p>
      </div>

      {error && (
        <div className="card p-3 border border-sun-300 bg-sun-50 text-sm text-sun-800">
          {error}
          {createdSlug && (
            <>
              {' '}
              <Link href={`/admin/guides/${createdSlug}`} className="underline font-medium">
                Open the guide and start it there
              </Link>
              .
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={handleCreate} disabled={busy} className="btn-primary text-sm disabled:opacity-50">
          {busy ? 'Creating & starting…' : 'Create guide & analyze'}
        </button>
      </div>
    </div>
  );
}
