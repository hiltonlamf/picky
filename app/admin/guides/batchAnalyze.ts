// Client-side sequential analyzer shared by the new-guide form and the guide
// workspace. Runs the EXISTING per-restaurant reparse route one restaurant at a
// time (never in parallel) so AI spend stays sequential, visible, and stoppable
// — the cost-discipline model the seed scripts already follow, moved into the UI.

export interface AnalyzeProgress {
  index: number; // 1-based position currently being analyzed
  total: number;
  restaurantId: string;
  phase: 'start' | 'result';
  outcome?: 'done' | 'no_menu' | 'error';
  dishCount?: number;
  costUsd?: number;
}

export interface AnalyzeSummary {
  totalCost: number;
  done: number;
  failed: number;
  stopped: boolean;
}

export async function analyzeSequentially(
  ids: string[],
  onProgress: (p: AnalyzeProgress) => void,
  shouldStop: () => boolean
): Promise<AnalyzeSummary> {
  let totalCost = 0;
  let done = 0;
  let failed = 0;
  let stopped = false;

  for (let i = 0; i < ids.length; i++) {
    if (shouldStop()) {
      stopped = true;
      break;
    }
    const id = ids[i];
    onProgress({ index: i + 1, total: ids.length, restaurantId: id, phase: 'start' });

    let outcome: AnalyzeProgress['outcome'] = 'error';
    let dishCount: number | undefined;
    let costUsd: number | undefined;
    try {
      const res = await fetch(`/api/admin/restaurants/${id}/reparse`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (typeof data.costUsd === 'number') {
        costUsd = data.costUsd;
        totalCost += data.costUsd;
      }
      dishCount = typeof data.dishCount === 'number' ? data.dishCount : undefined;
      outcome = data.outcome === 'done' ? 'done' : data.outcome === 'no_menu' ? 'no_menu' : 'error';
    } catch {
      outcome = 'error';
    }
    if (outcome === 'done') done++;
    else failed++;

    onProgress({ index: i + 1, total: ids.length, restaurantId: id, phase: 'result', outcome, dishCount, costUsd });
  }

  return { totalCost, done, failed, stopped };
}
