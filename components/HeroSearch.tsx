'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ParseProgress from './ParseProgress';
import { capture } from '@/lib/posthog-client';
import { EVENTS, captureError, classifyError } from '@/lib/analytics';
import { domainOf, FIRST_ANALYSIS_KEY } from '@/lib/telemetry';
import type { ParseEvent, MenuCandidate } from '@/types';
import { CloseIcon, DocIcon, CameraIcon, LinkIcon, PageIcon, CheckIcon } from './icons';

type AppState = 'idle' | 'parsing' | 'selecting' | 'error';

const TYPE_META: Record<MenuCandidate['type'], { Icon: typeof DocIcon; source: string }> = {
  text: { Icon: PageIcon, source: 'Menu text' },
  pdf: { Icon: DocIcon, source: 'PDF menu' },
  image: { Icon: CameraIcon, source: 'Photo' },
  subpage: { Icon: LinkIcon, source: 'Menu page' },
};

export default function HeroSearch({
  autoFocusInput = false,
  onCancel,
  cancelLabel,
}: {
  /**
   * Focus the URL field on mount. True only when a person opened the panel —
   * never on page load, where it used to steal focus and pop the mobile
   * keyboard before anyone had decided what they wanted.
   */
  autoFocusInput?: boolean;
  /** Collapse the panel. Only ever offered in the 'idle' state. */
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<MenuCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Set the moment the stream reaches ANY terminal outcome. The terminal
  // branches navigate away with router.push while `state` is still 'parsing',
  // so without this the unmount cleanup reports a completed analysis as
  // abandoned — which is what happened on the first real run and would have
  // made the metric read ~100% abandonment.
  const reachedTerminalRef = useRef(false);

  // preventScroll keeps the headline in frame: without it, focusing a field
  // near the fold jumps the page on mobile the instant the panel opens.
  useEffect(() => {
    if (autoFocusInput) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocusInput]);

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
            // The picker screen is its own funnel step: menus_selected only
            // fires for people who go on to continue, so without this an
            // abandonment here looked identical to never reaching it.
            capture(EVENTS.MENU_CANDIDATES_SHOWN, {
              restaurant_id: event.restaurantId,
              count: event.candidates.length,
              types: event.candidates.map((c) => c.type),
            });
            return 'done';
          } else if (event.type === 'continue') {
            return { continueWith: event.restaurantId };
          } else if (event.type === 'result' || event.type === 'cached') {
            // Anchor for the day-7+ NPS prompt: first time this browser
            // successfully got a menu (fresh analysis or cache hit).
            if (!localStorage.getItem(FIRST_ANALYSIS_KEY)) {
              localStorage.setItem(FIRST_ANALYSIS_KEY, String(Date.now()));
            }
            reachedTerminalRef.current = true;
            router.push(`/restaurant/${event.restaurantId}`);
            return 'done';
          } else if (event.type === 'no_menu') {
            // Not an error: the site has no readable menu / is down. The results
            // page renders a friendly, actionable screen (paste a link / upload
            // a photo) keyed off the restaurant's no_menu_reason.
            // The reason lives on the restaurant row, not the SSE event, so
            // it's attached to results_viewed on the results page instead.
            reachedTerminalRef.current = true;
            capture(EVENTS.NO_MENU_RESULT, { restaurant_id: event.restaurantId });
            router.push(`/restaurant/${event.restaurantId}`);
            return 'done';
          } else if (event.type === 'error') {
            reachedTerminalRef.current = true;
            setError(event.error ?? 'An error occurred');
            setState('error');
            captureError({ surface: 'search', message: event.error ?? 'An error occurred' });
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

  /**
   * The main drop-off in the product: analysis is slow, and until now someone
   * closing the tab mid-wait was indistinguishable from someone who never
   * searched. Recording elapsed time is what turns "people leave" into "people
   * leave after N seconds", which is the number that decides whether the wait
   * needs work.
   *
   * Refs rather than state so the listener always sees current values without
   * being torn down and re-attached on every progress line.
   */
  const parsingRef = useRef<{ startedAt: number; step: string; domain: string | null } | null>(null);
  parsingRef.current =
    state === 'parsing' && startedAt
      ? { startedAt, step: log[log.length - 1] ?? 'starting', domain: domainOf(url.trim()) }
      : null;

  useEffect(() => {
    const report = () => {
      // Checked HERE, not while computing parsingRef, and that distinction is the
      // whole bug. parsingRef is assigned during render; setting a ref does not
      // trigger a re-render, so when a terminal SSE event sets
      // reachedTerminalRef the render that would have cleared parsingRef never
      // happens. The stale non-null value then survived to unmount and reported
      // a completed analysis as abandoned — which is exactly what shipped and
      // showed up on real traffic twice, on searches that returned 28 and 27
      // dishes. Reading the flag at report time is immune to render timing.
      if (reachedTerminalRef.current) return;
      const p = parsingRef.current;
      if (!p) return;
      parsingRef.current = null; // once per abandonment
      capture(EVENTS.ANALYSIS_ABANDONED, {
        elapsed_ms: Date.now() - p.startedAt,
        last_step: p.step,
        domain: p.domain,
      });
    };
    // pagehide beats beforeunload on mobile Safari, where beforeunload often
    // never fires at all — and mobile is where a slow wait hurts most.
    window.addEventListener('pagehide', report);
    return () => {
      window.removeEventListener('pagehide', report);
      report(); // also covers client-side navigation away mid-analysis
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      // The button stays live even with an empty field, so say what's missing
      // and put the cursor where it's needed.
      if (!trimmed) {
        setError('Paste a restaurant link first — a homepage or a menu page both work.');
        inputRef.current?.focus();
        return;
      }

      const submittedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      capture(EVENTS.SEARCH_SUBMITTED, {
        domain: domainOf(submittedUrl),
        // Whether they pasted a bare homepage or a deep menu link — it strongly
        // predicts whether discovery succeeds, so the funnel can be split on it.
        url_has_path: (() => {
          try { return new URL(submittedUrl).pathname.replace(/\/$/, '').length > 0; } catch { return false; }
        })(),
      });

      reachedTerminalRef.current = false;
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
        const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
        setError(msg);
        setState('error');
        captureError({
          surface: 'search',
          message: msg,
          extra: { domain: domainOf(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`) },
        });
      }
    },
    [url, followStream]
  );

  const handleAnalyzeSelected = useCallback(async () => {
    if (!restaurantId || selectedIds.length === 0) return;
    capture('menus_selected', { count: selectedIds.length, total_candidates: candidates.length });
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
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setError(msg);
      setState('error');
      // Previously silent: this path showed the visitor an error while its
      // sibling in handleSubmit reported one, so post-picker failures were
      // invisible.
      captureError({ surface: 'menu_selection', message: msg, restaurantId });
    }
  }, [restaurantId, selectedIds, candidates, followStream]);

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
      <div className="w-full max-w-xl flex flex-col gap-4 mt-7">
        <div>
          <p className="eyebrow-light mb-2">
            {candidates.length} {candidates.length === 1 ? 'menu' : 'menus'} found
          </p>
          <h2 className="font-display text-xl text-paper">
            {candidates.length === 1 ? 'One menu. Shall we read it?' : `${candidates.length} menus. Your call.`}
          </h2>
          <p className="text-sm text-paper/75 mt-1">Pick what matters, or let it read them all.</p>
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
                  className={`glass w-full flex items-start gap-3.5 rounded-2xl px-4 py-3.5 text-left transition ${
                    checked ? '!border-azalea-400 bg-azalea-500/15' : 'hover:bg-white/[0.16]'
                  }`}
                >
                  <span className="w-9 h-9 rounded-xl bg-white/15 text-azalea-400 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-paper">{c.label}</span>
                    {c.description && (
                      <span className="block text-xs text-paper/75 mt-0.5">{c.description}</span>
                    )}
                    <span className="inline-block text-[10px] font-mono uppercase tracking-wide text-paper/80 bg-white/10 rounded px-1.5 py-0.5 mt-1.5">
                      {source}
                    </span>
                  </span>
                  <span
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      checked ? 'border-azalea-400 bg-azalea-500 text-white' : 'border-white/40 text-transparent'
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
          <button onClick={handleAnalyzeSelected} disabled={selectedIds.length === 0} className="btn-cta">
            {allSelected
              ? `Read all ${candidates.length} menus`
              : selectedIds.length === 0
              ? 'Pick at least one menu'
              : `Read ${selectedIds.length} ${selectedIds.length === 1 ? 'menu' : 'menus'}`}
          </button>
          <button onClick={reset} className="text-sm text-paper/75 hover:text-paper transition-colors px-2 py-2">
            ← Start over
          </button>
        </div>
        <p className="text-xs text-paper/70 font-mono">~20–40s per menu · narrated live</p>
      </div>
    );
  }

  if (state === 'parsing' || state === 'error') {
    return (
      <div className="flex flex-col items-start gap-5 mt-7 w-full">
        <ParseProgress log={log} startedAt={startedAt} error={state === 'error' ? error : null} />
        {state === 'error' && (
          <button
            onClick={reset}
            className="text-sm text-paper/75 hover:text-paper transition-colors px-2 py-2"
          >
            ← Try a different link
          </button>
        )}
      </div>
    );
  }

  // The white field against the dark hero is deliberate: a translucent input on
  // a dark ground reads as decoration, while a white box reads as "type here".
  return (
    <form
      onSubmit={handleSubmit}
      // Escape lives on the form, not on window, so it can't fight the feedback
      // modal or the NPS prompt — and because the parsing/selecting/error
      // branches return above this JSX, it is structurally unreachable outside
      // the idle state. Gated on an empty field: closing the panel discards the
      // component, and Escape must never throw away a link someone just pasted.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onCancel && !url.trim()) {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="w-full max-w-[760px] mt-5"
    >
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 min-w-0">
          <LinkIcon className="w-[19px] h-[19px] text-azalea-700 absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Paste a restaurant website link"
            // ph-no-mask: replay masks all inputs by default, which is right —
            // but this field is the whole point of watching a replay, since
            // without it a failed search is an invisible cursor in an empty box.
            // A public restaurant URL is not personal data.
            className="paste-field pl-[46px] pr-11 text-base ph-no-mask"
            autoComplete="url"
            aria-label="Restaurant website link"
            aria-invalid={!!error}
            ref={inputRef}
          />
          {url && (
            <button
              type="button"
              onClick={() => setUrl('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-forest/60 hover:text-forest p-1"
              aria-label="Clear"
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          )}
        </div>
        {/* Never greyed out: an inviting CTA that asks for a link if it's empty
            beats a dead button the visitor can't act on. */}
        <button type="submit" className="btn-cta shrink-0">
          🥦 Find my veggies →
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-azalea-400">
          {error}
        </p>
      )}

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-sm text-paper/75 hover:text-paper transition-colors px-2 py-2"
        >
          {cancelLabel ?? 'Cancel'}
        </button>
      )}
    </form>
  );
}
