import type { AnalyzeProgress } from './batchAnalyze';

// How a restaurant's state is shown in the guide workspace.
//
// There are two sources of truth and they disagree on purpose. The database
// only records an outcome once a restaurant's analysis has FINISHED, so during
// a batch every row still waiting its turn looks identical to one that was
// never touched. The browser running the batch is the only thing that knows
// the difference — so its live view wins whenever it has one.

/** What the batch running in the current browser tab knows about a restaurant. */
export type LiveState =
  | { phase: 'queued' }
  | { phase: 'analyzing' }
  | { phase: 'result'; outcome: 'done' | 'no_menu' | 'error'; dishCount?: number };

/** Everything in a batch starts queued; the analyzer then walks through them. */
export function startLive(ids: string[]): Record<string, LiveState> {
  return Object.fromEntries(ids.map((id) => [id, { phase: 'queued' } as LiveState]));
}

/** Fold one progress event from the analyzer into the live view. */
export function applyProgress(live: Record<string, LiveState>, p: AnalyzeProgress): Record<string, LiveState> {
  return {
    ...live,
    [p.restaurantId]:
      p.phase === 'start'
        ? { phase: 'analyzing' }
        : { phase: 'result', outcome: p.outcome ?? 'error', dishCount: p.dishCount },
  };
}

/**
 * Called when a run ends. Finished outcomes stay on screen (the server refresh
 * is async, so dropping them would flash every row back to its old status), but
 * anything still queued or analyzing is discarded — if the run was stopped
 * early, nothing is coming for those rows and the badge would be a lie.
 */
export function settleLive(live: Record<string, LiveState>): Record<string, LiveState> {
  return Object.fromEntries(Object.entries(live).filter(([, v]) => v.phase === 'result'));
}

export interface Badge {
  label: string;
  className: string;
  /** Shows an animated dot — only for work that is genuinely in flight. */
  active?: boolean;
  title?: string;
}

const QUEUED_CLASS = 'bg-mint-50 text-evergreen/80';
const WARN_CLASS = 'bg-sun-50 text-sun-800';

const OUTCOME_BADGES: Record<string, Badge> = {
  done: { label: 'Analyzed', className: 'bg-mint-100 text-picky-700' },
  no_menu: { label: 'No menu', className: WARN_CLASS },
  error: { label: 'Error', className: WARN_CLASS },
};

export function statusBadge(status: string, live?: LiveState): Badge {
  if (live?.phase === 'queued') {
    return { label: 'Queued', className: QUEUED_CLASS, title: 'Waiting for its turn in the current batch' };
  }
  if (live?.phase === 'analyzing') {
    return {
      label: 'Analyzing',
      className: 'bg-picky-100 text-picky-700',
      active: true,
      title: 'Being analyzed right now',
    };
  }
  if (live?.phase === 'result') return OUTCOME_BADGES[live.outcome] ?? OUTCOME_BADGES.error;

  if (status === 'pending') {
    return { label: 'Queued', className: QUEUED_CLASS, title: 'Added but not analyzed yet' };
  }
  if (status === 'processing') {
    // Nothing is driving this row from this tab, yet it never finished — almost
    // always an interrupted run (tab closed, request timed out). Say so, rather
    // than showing "processing" forever, which reads as "still working" and is
    // what made a stalled Amsterdam row look like it was in progress for hours.
    return {
      label: 'Interrupted',
      className: WARN_CLASS,
      title: 'An earlier analysis started but never finished — use “Analyze queued” to run it again',
    };
  }
  return OUTCOME_BADGES[status] ?? { label: status, className: 'bg-mint-100 text-evergreen/80' };
}
