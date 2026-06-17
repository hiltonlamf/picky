'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ParseProgress from './ParseProgress';
import type { ParseEvent, ParseProgressEvent } from '@/types';

type AppState = 'idle' | 'parsing' | 'error';

export default function HeroSearch() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [state, setState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ParseProgressEvent | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) return;

      setState('parsing');
      setError(null);
      setCurrentStep(null);

      try {
        const response = await fetch('/api/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
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
              setCurrentStep(event);
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
    [input, router]
  );

  const reset = () => {
    setState('idle');
    setError(null);
    setCurrentStep(null);
  };

  if (state === 'parsing' || state === 'error') {
    return (
      <div className="flex flex-col items-center gap-6">
        <ParseProgress
          currentStep={currentStep}
          error={state === 'error' ? error : null}
        />
        {state === 'error' && (
          <button onClick={reset} className="btn-ghost text-sm">
            ← Try again
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Restaurant name or website URL"
            className="input-url pr-12 text-base"
            autoComplete="off"
            autoFocus
            aria-label="Restaurant name or URL"
          />
          {input && (
            <button
              type="button"
              onClick={() => setInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
              aria-label="Clear"
            >
              ✕
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={!input.trim()}
          className="btn-primary text-base w-full sm:w-auto sm:self-start"
        >
          Find my food →
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
        <span>✓ Restaurant names</span>
        <span>✓ Website URLs</span>
        <span>✓ Google Maps links</span>
      </div>
    </form>
  );
}
