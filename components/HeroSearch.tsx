'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ParseProgress from './ParseProgress';
import type { ParseEvent, ParseProgressEvent, MenuCandidate } from '@/types';

type AppState = 'idle' | 'parsing' | 'selecting' | 'error';

const TYPE_EMOJI: Record<MenuCandidate['type'], string> = {
  text: '📝',
  pdf: '📄',
  image: '🖼️',
  subpage: '🔗',
};

export default function HeroSearch() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ParseProgressEvent | null>(null);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<MenuCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);

  // Consume an SSE stream from a fetch Response. Returns when the stream ends
  // or an outcome (redirect / candidates / error) is reached.
  const consumeStream = useCallback(
    async (response: Response): Promise<void> => {
      if (!response.body) throw new Error('No response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const allSteps = [
        'Checking our database...',
        'Fetching the restaurant page...',
        'Finding the menus...',
        'Analysing dishes with AI...',
      ];

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
            setCurrentStep(event);
            setCompletedSteps(allSteps.slice(0, event.stepNumber - 1));
          } else if (event.type === 'candidates') {
            setRestaurantId(event.restaurantId);
            setCandidates(event.candidates);
            setSelectedIds(event.candidates.map((c) => c.id)); // default: all selected
            setState('selecting');
            return;
          } else if (event.type === 'result' || event.type === 'cached') {
            router.push(`/restaurant/${event.restaurantId}`);
            return;
          } else if (event.type === 'error') {
            setError(event.error ?? 'An error occurred');
            setState('error');
            return;
          }
        }
      }
    },
    [router]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (!trimmed) return;

      setState('parsing');
      setError(null);
      setCurrentStep(null);
      setCompletedSteps([]);
      setCandidates([]);
      setSelectedIds([]);
      setRestaurantId(null);

      try {
        const response = await fetch('/api/parse/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}` }),
        });
        await consumeStream(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
        setState('error');
      }
    },
    [url, consumeStream]
  );

  const handleAnalyzeSelected = useCallback(async () => {
    if (!restaurantId || selectedIds.length === 0) return;
    setState('parsing');
    setError(null);
    setCurrentStep(null);
    setCompletedSteps([]);

    try {
      const response = await fetch('/api/parse/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId, candidateIds: selectedIds }),
      });
      await consumeStream(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setState('error');
    }
  }, [restaurantId, selectedIds, consumeStream]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const reset = () => {
    setState('idle');
    setError(null);
    setCurrentStep(null);
    setCompletedSteps([]);
    setCandidates([]);
    setSelectedIds([]);
    setRestaurantId(null);
  };

  if (state === 'selecting') {
    return (
      <div className="w-full max-w-xl flex flex-col gap-4">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-800">This place has more than one menu</h2>
          <p className="text-sm text-gray-500">Pick the menu(s) you want us to analyse.</p>
        </div>
        <ul className="flex flex-col gap-2">
          {candidates.map((c) => {
            const checked = selectedIds.includes(c.id);
            return (
              <li key={c.id}>
                <label
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition ${
                    checked ? 'border-picky-500 bg-picky-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4 accent-picky-600"
                  />
                  <span className="text-lg" aria-hidden>
                    {TYPE_EMOJI[c.type]}
                  </span>
                  <span className="text-sm font-medium text-gray-800">{c.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-3">
          <button
            onClick={handleAnalyzeSelected}
            disabled={selectedIds.length === 0}
            className="btn-primary text-base"
          >
            Analyse {selectedIds.length > 1 ? `${selectedIds.length} menus` : 'menu'} →
          </button>
          <button onClick={reset} className="btn-ghost text-sm">
            ← Start over
          </button>
        </div>
      </div>
    );
  }

  if (state === 'parsing' || state === 'error') {
    return (
      <div className="flex flex-col items-center gap-6">
        <ParseProgress
          currentStep={currentStep}
          completedSteps={completedSteps}
          error={state === 'error' ? error : null}
        />
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
            placeholder="www.restaurant.com"
            className="input-url pr-12 text-base"
            autoComplete="url"
            autoFocus
            aria-label="Restaurant URL"
          />
          {url && (
            <button
              type="button"
              onClick={() => setUrl('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
              aria-label="Clear"
            >
              ✕
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

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
        <span>✓ Restaurant websites</span>
      </div>
    </form>
  );
}
