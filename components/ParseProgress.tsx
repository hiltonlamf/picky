'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertIcon } from './icons';

interface Props {
  log: string[];
  error: string | null;
}

const PHASES = ['Found the menu', 'Reading dishes', 'Double-checking', 'Saving'];

// Playful, and honest about what the model is hunting for. Purely decorative:
// aria-hidden so it never competes with the real narration below, which is the
// live region screen-reader users actually follow.
const TICKER_WORDS = [
  'tofu…',
  'tempeh…',
  'halloumi…',
  'jackfruit…',
  'aubergine…',
  'chickpeas…',
  'butter beans…',
  'harissa…',
  'anything but another mushroom risotto…',
];
const TICKER_MS = 1600;

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

/** Rotating ingredient word. Frozen for anyone who asked for reduced motion. */
function useTickerWord(active: boolean): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % TICKER_WORDS.length), TICKER_MS);
    return () => clearInterval(id);
  }, [active]);
  return TICKER_WORDS[index];
}

export default function ParseProgress({ log, error }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const lastStep = log[log.length - 1] ?? '';
  const activePhase = phaseOf(lastStep);
  const tickerWord = useTickerWord(!error);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [log]);

  return (
    <div className="glass w-full max-w-[480px] rounded-3xl p-6 text-paper">
      <div className="flex items-start gap-3">
        <span
          className="mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-azalea-400 shadow-[0_0_14px_rgba(255,95,174,0.85)] animate-blink"
          aria-hidden="true"
        />
        <div>
          <p className="font-display text-lg">We&rsquo;re tofu-analysing it now</p>
          <p className="text-[0.8rem] text-paper/70 mt-1 leading-relaxed">
            Most menus are ready in under a minute. The extra-crunchy ones can take a little longer.
          </p>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl bg-sun-50 p-4 mt-4">
          <p className="text-sm font-semibold text-sun-800 mb-1 flex items-center gap-2">
            <AlertIcon className="w-4 h-4" />
            That one didn&apos;t work
          </p>
          <p className="text-sm text-sun-800/90">{error}</p>
          <p className="text-xs text-sun-800/80 mt-2">
            If this keeps happening on a site that definitely has a menu, tell us — we read what
            comes in.
          </p>
        </div>
      ) : (
        <>
          <div
            className="glass rounded-2xl px-4 py-3 mt-4 flex items-baseline gap-2 text-[0.8rem]"
            aria-hidden="true"
          >
            <span className="text-paper/65">Looking for</span>
            <span className="font-display text-base text-azalea-400">{tickerWord}</span>
          </div>

          <div className="flex gap-1.5 flex-wrap mt-4">
            {PHASES.map((label, i) => (
              <div
                key={label}
                className={`flex-1 min-w-[96px] flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-mono transition-colors ${
                  i < activePhase
                    ? 'border-lime/45 text-lime'
                    : i === activePhase
                    ? 'border-azalea-400/85 text-azalea-400 bg-azalea-500/15'
                    : 'border-white/15 text-paper/60'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    i <= activePhase ? 'bg-current' : 'bg-white/30'
                  } ${i === activePhase ? 'animate-blink' : ''}`}
                />
                {label}
              </div>
            ))}
          </div>

          <div
            ref={feedRef}
            role="log"
            aria-live="polite"
            aria-atomic="false"
            aria-relevant="additions"
            className="max-h-52 overflow-y-auto space-y-2 pr-1 mt-4"
          >
            {log.length === 0 && <p className="text-paper/60 text-xs font-mono">Connecting…</p>}
            {log.map((line, i) => (
              <p
                key={i}
                className={`animate-rise text-[13px] leading-relaxed font-mono ${
                  i === log.length - 1 ? 'text-lime' : 'text-paper/75'
                }`}
              >
                <span className="text-azalea-400 mr-2 tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {line}
                {i === log.length - 1 && (
                  <span
                    className="inline-block w-1.5 h-3.5 bg-lime ml-1 align-middle animate-blink"
                    aria-hidden="true"
                  />
                )}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
