'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ParseProgress from './ParseProgress';
import type { ParseEvent, MenuCandidate } from '@/types';
import { CloseIcon, DocIcon, CameraIcon, LinkIcon, PageIcon, CheckIcon } from './icons';

type AppState = 'idle' | 'parsing' | 'selecting' | 'error';

const TYPE_META: Record<MenuCandidate['type'], { Icon: typeof DocIcon; source: string }> = {
  text: { Icon: PageIcon, source: 'Menu text' },
  pdf: { Icon: DocIcon, source: 'PDF menu' },
  image: { Icon: CameraIcon, source: 'Photo' },
  subpage: { Icon: LinkIcon, source: 'Menu page' },
};

export default function HeroSearch() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<MenuCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);

  // Consume an SSE stream from a fetch Response. Resolves 'done' on a terminal
  // outcome (redirect / candidates / error), or the restaurantId to continue
  // with when the server ran out of serverless time budget mid-analysis.
  const consumeStream = useCallback(
    async (response: Response): Promise<'done' | { continueWith: string }> => {
      if (!response.body) throw new Error('No response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: ParseEvent;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          if (event.type === 'progress') {
            setLog((prev) => (prev[prev.length - 1] === event.step ? prev : [...prev, event.step]));
          } else if (event.type === 'candidates') {
            setRestaurantId(event.restaurantId);
            setCandidates(event.candidates);
            setSelectedIds(event.candidates.map((c) => c.id)); // default: all selected
            setState('selecting');
            return 'done';
          } else if (event.type === 'continue') {
            return { continueWith: event.restaurantId };
          } else if (event.type === 'result' || event.type === 'cached') {
            router.push(`/restaurant/${event.restaurantId}`);
            return 'done';
          } else if (event.type === 'error') {
            setError(event.error ?? 'An error occurred');
            setState('error');
            return 'done';
          }
        }
      }

      // Stream closed without a result/candidates/error event — the server
      // was cut off mid-analysis. Fail visibly rather than spinning forever.
      throw new Error(
        'The analysis took longer than expected and the connection dropped. Please try again — a retry usually succeeds.'
      );
    },
    [router]
  );

  // Follow a stream through any number of 'continue' hops: each hop resumes
  // the stored analysis in a fresh (time-capped) serverless request.
  const followStream = useCallback(
    async (response: Response): Promise<void> => {
      let outcome = await consumeStream(response);
      let hops = 0;
      while (outcome !== 'done') {
        if (++hops > 20) {
          throw new Error('The analysis is taking much longer than expected. Please try again later.');
        }
        const next = await fetch('/api/parse/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: outcome.continueWith }),
        });
        outcome = await consumeStream(next);
      }
    },
    [consumeStream]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (!trimmed) return;

      setState('parsing');
      setError(null);
      setLog([]);
      setStartedAt(Date.now());
      setCandidates([]);
      setSelectedIds([]);
      setRestaurantId(null);

      try {
        const response = await fetch('/api/parse/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}` }),
        });
        await followStream(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
        setState('error');
      }
    },
    [url, followStream]
  );

  const handleAnalyzeSelected = useCallback(async () => {
    if (!restaurantId || selectedIds.length === 0) return;
    setState('parsing');
    setError(null);
    setLog([]);
    setStartedAt(Date.now());

    try {
      const response = await fetch('/api/parse/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId, candidateIds: selectedIds }),
      });
      await followStream(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setState('error');
    }
  }, [restaurantId, selectedIds, followStream]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const reset = () => {
    setState('idle');
    setError(null);
    setLog([]);
    setStartedAt(null);
    setCandidates([]);
    setSelectedIds([]);
    setRestaurantId(null);
  };

  if (state === 'selecting') {
    const allSelected = selectedIds.length === candidates.length;
    return (
      <div className="w-full max-w-xl flex flex-col gap-4">
        <div className="text-center">
          <p className="eyebrow mb-2">AI scout · {candidates.length} menus found</p>
          <h2 className="text-lg font-bold text-evergreen">Three menus. Your call.</h2>
          <p className="text-sm text-evergreen/80">Pick what matters, or let the AI read them all.</p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {candidates.map((c) => {
            const checked = selectedIds.includes(c.id);
            const { Icon, source } = TYPE_META[c.type];
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  aria-pressed={checked}
                  className={`w-full flex items-start gap-3.5 rounded-2xl border-2 px-4 py-3.5 text-left transition ${
                    checked ? 'border-picky-500 bg-picky-50' : 'border-mint-200 hover:border-mint-200/70 bg-white'
                  }`}
                >
                  <span className="w-9 h-9 rounded-xl bg-mint-100 text-picky-600 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-evergreen">{c.label}</span>
                    {c.description && (
                      <span className="block text-xs text-evergreen/80 mt-0.5">{c.description}</span>
                    )}
                    <span className="inline-block text-[10px] font-mono uppercase tracking-wide text-evergreen/80 bg-mint-100 rounded px-1.5 py-0.5 mt-1.5">
                      {source}
                    </span>
                  </span>
                  <span
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      checked ? 'border-picky-500 bg-picky-500 text-white' : 'border-mint-200 text-transparent'
                    }`}
                  >
                    <CheckIcon className="w-3 h-3" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleAnalyzeSelected}
            disabled={selectedIds.length === 0}
            className="btn-primary text-base"
          >
            {allSelected
              ? `Read all ${candidates.length} menus`
              : selectedIds.length === 0
              ? 'Pick at least one menu'
              : `Read ${selectedIds.length} ${selectedIds.length === 1 ? 'menu' : 'menus'}`}
          </button>
          <button onClick={reset} className="btn-ghost text-sm">
            ← Start over
          </button>
        </div>
        <p className="text-xs text-evergreen/80 font-mono">~20–40s per menu · narrated live</p>
      </div>
    );
  }

  if (state === 'parsing' || state === 'error') {
    return (
      <div className="flex flex-col items-center gap-6">
        <ParseProgress log={log} startedAt={startedAt} error={state === 'error' ? error : null} />
        {state === 'error' && (
          <button onClick={reset} className="btn-ghost text-sm">
            ← Try a different link
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-xl">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="drop a restaurant link…"
            className="input-url pr-12 text-base"
            autoComplete="url"
            autoFocus
            aria-label="Restaurant URL"
          />
          {url && (
            <button
              type="button"
              onClick={() => setUrl('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-evergreen/80 hover:text-evergreen p-1"
              aria-label="Clear"
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={!url.trim()}
          className="btn-primary text-base w-full sm:w-auto sm:self-start"
        >
          Find my food →
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-evergreen/80">
        <span>Works with any restaurant website — the AI finds the menu itself.</span>
      </div>
    </form>
  );
}
