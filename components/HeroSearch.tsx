'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ParseProgress from './ParseProgress';
import type { ParseEvent, ParseProgressEvent } from '@/types';

type AppState = 'idle' | 'parsing' | 'error';

export default function HeroSearch() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ParseProgressEvent | null>(null);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (!trimmed) return;

      setState('parsing');
      setError(null);
      setCurrentStep(null);
      setCompletedSteps([]);

      try {
        const response = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed.startsWith('http') ? trimmed : `https://${trimmed}` }),
        });

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
              // Mark all steps before the current one as complete
              const allSteps = [
                'Checking our database...',
                'Fetching the restaurant page...',
                'Analysing dishes with AI...',
                'Saving your results...',
              ];
              setCurrentStep(event);
              setCompletedSteps(allSteps.slice(0, event.stepNumber - 1));
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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
        setState('error');
      }
    },
    [url, router]
  );

  const reset = () => {
    setState('idle');
    setError(null);
    setCurrentStep(null);
    setCompletedSteps([]);
  };

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
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://restaurant.com or Google Maps link"
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
        <span>✓ Google Maps links</span>
        <span>✓ Direct menu URLs</span>
      </div>
    </form>
  );
}
