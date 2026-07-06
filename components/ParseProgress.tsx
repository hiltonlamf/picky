'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertIcon } from './icons';

interface Props {
  log: string[];
  startedAt: number | null;
  error: string | null;
}

const PHASES = ['Finding the menu', 'Reading dishes', 'Verifying labels', 'Saving'];

/**
 * Classify a free-form server narration line into a coarse phase. The
 * backend emits many distinct messages per pipeline stage (which PDF is
 * being read, which retry rung is active, which resume hop this is) — this
 * matches by keyword rather than exact string so every message drives the
 * phase tracker instead of only four hardcoded ones.
 */
function phaseOf(step: string): number {
  const s = step.toLowerCase();
  if (s.includes('saving')) return 3;
  if (s.includes('double-check') || s.includes('verify')) return 2;
  if (
    s.includes('reading') ||
    s.includes('scan') ||
    s.includes('combin') ||
    s.includes('classif') ||
    s.includes('pdf') ||
    s.includes('image') ||
    s.includes('photo') ||
    s.includes('snapshot') ||
    s.includes('strongest') ||
    s.includes('opening') ||
    s.includes('still reading')
  )
    return 1;
  return 0;
}

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => startedAt ?? Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return '0.0s';
  return `${((now - startedAt) / 1000).toFixed(1)}s`;
}

export default function ParseProgress({ log, startedAt, error }: Props) {
  const elapsed = useElapsed(startedAt);
  const feedRef = useRef<HTMLDivElement>(null);
  const lastStep = log[log.length - 1] ?? '';
  const activePhase = phaseOf(lastStep);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [log]);

  return (
    <div className="ai-trace w-full max-w-md p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="font-bold text-mint-50">The AI is reading the menu</p>
        <span className="font-mono text-xs text-aqua tabular-nums bg-evergreen-light rounded-md px-2 py-0.5">
          {elapsed}
        </span>
      </div>
      <p className="text-xs text-mint-200/70 mb-4">
        Usually under a minute — this is the model actually working, narrated live below.
      </p>

      {error ? (
        <div className="rounded-xl bg-sun-50 p-4">
          <p className="text-sm font-semibold text-sun-800 mb-1 flex items-center gap-2">
            <AlertIcon className="w-4 h-4" />
            The AI hit a snag
          </p>
          <p className="text-sm text-sun-800/90">{error}</p>
        </div>
      ) : (
        <>
          <div className="flex gap-1.5 flex-wrap mb-4">
            {PHASES.map((label, i) => (
              <div
                key={label}
                className={`flex-1 min-w-[90px] flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-mono transition-colors ${
                  i < activePhase
                    ? 'border-picky-500/40 text-picky-500'
                    : i === activePhase
                    ? 'border-lime text-lime'
                    : 'border-evergreen-line text-mint-200/40'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    i <= activePhase ? 'bg-current' : 'bg-evergreen-line'
                  } ${i === activePhase ? 'animate-blink' : ''}`}
                />
                {label}
              </div>
            ))}
          </div>

          <div ref={feedRef} className="max-h-52 overflow-y-auto space-y-2 pr-1">
            {log.length === 0 && (
              <p className="text-mint-200/50 text-xs">Connecting…</p>
            )}
            {log.map((line, i) => (
              <p
                key={i}
                className={`animate-rise text-[13px] leading-relaxed ${
                  i === log.length - 1 ? 'text-lime font-medium' : 'text-mint-200/60'
                }`}
              >
                <span className="text-aqua/70 mr-2 tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {line}
                {i === log.length - 1 && <span className="inline-block w-1.5 h-3.5 bg-lime ml-1 align-middle animate-blink" />}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
