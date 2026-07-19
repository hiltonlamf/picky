/**
 * Free retrospective scoring for the auto-growing golden set. Zero LLM calls —
 * pure DB reads, shared by `scripts/run-eval.ts` and the Evaluation Dashboard.
 *
 * Accuracy is HONEST: it compares what the AI ORIGINALLY guessed for each dish
 * (captured at the moment of the human verdict, before the correction
 * overwrote the live label) against the human-confirmed answer. Comparing
 * against the *live* label instead would always read ~100% once a dish is
 * corrected, since the correction also updates the live row.
 *
 * A separate "still live" count is kept purely as coverage — how many
 * ground-truth dishes still exist in the current live menu (e.g. did a reparse
 * drop them) — and never feeds the accuracy number.
 *
 * "Fresh paid re-run" (score against a brand-new AI pass) is out of scope for
 * v1 — see the plan file.
 */
import type { DietaryClassification, EvalCase, EvalMenuCandidate } from '@/types';
import { getEvalCases, getEvalCaseDetail, getLiveMenuForUrl } from './db';

const CLASSES: DietaryClassification[] = ['vegan', 'vegetarian', 'neither', 'unknown'];

export type ConfusionMatrix = Record<DietaryClassification, Record<DietaryClassification, number>>;

export interface UnsafeMislabel {
  dishName: string;
  /** What the AI originally guessed (vegan/vegetarian) for a dish that's actually 'neither'. */
  aiClassification: DietaryClassification;
}

export interface EvalCaseScore {
  evalCase: EvalCase;
  liveFound: boolean;
  totalGroundTruthDishes: number;
  /** Ground-truth dishes still present in the live menu by name — coverage only. */
  stillLiveDishes: number;
  /** Ground-truth dishes with a captured AI original guess (i.e. scoreable). */
  scoredDishes: number;
  correctDishes: number;
  /** null when no dish has a captured AI original guess yet. */
  accuracyPct: number | null;
  /** Rows = human-confirmed answer, cols = AI's original guess. */
  confusion: ConfusionMatrix;
  /** Human confirmed 'neither' but the AI originally guessed 'vegan'/'vegetarian' —
   *  the one error class that must never hide inside an aggregate accuracy %. */
  unsafeMislabels: UnsafeMislabel[];
  menuCandidates: EvalMenuCandidate[];
  missedMenus: string | null;
}

function emptyMatrix(): ConfusionMatrix {
  const m = {} as ConfusionMatrix;
  for (const expected of CLASSES) {
    m[expected] = {} as Record<DietaryClassification, number>;
    for (const actual of CLASSES) m[expected][actual] = 0;
  }
  return m;
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

export async function scoreEvalCase(caseId: string): Promise<EvalCaseScore | null> {
  const detail = await getEvalCaseDetail(caseId);
  if (!detail) return null;
  const { evalCase, menuCandidates, dishes } = detail;

  const confusion = emptyMatrix();
  const unsafeMislabels: UnsafeMislabel[] = [];
  let scored = 0;
  let correct = 0;

  for (const gt of dishes) {
    const ai = gt.aiOriginalClassification;
    if (!ai) continue; // no captured AI guess (legacy/added dish) — not scoreable
    scored++;
    confusion[gt.expectedClassification][ai]++;
    if (ai === gt.expectedClassification) correct++;
    if (gt.expectedClassification === 'neither' && (ai === 'vegan' || ai === 'vegetarian')) {
      unsafeMislabels.push({ dishName: gt.name, aiClassification: ai });
    }
  }

  // Coverage only: how many ground-truth dishes still exist live by name.
  const live = await getLiveMenuForUrl(evalCase.url);
  let stillLive = 0;
  if (live) {
    const liveNames = new Set<string>();
    for (const section of live.sections) for (const d of section.dishes) liveNames.add(norm(d.name));
    for (const gt of dishes) if (liveNames.has(norm(gt.name))) stillLive++;
  }

  return {
    evalCase,
    liveFound: !!live,
    totalGroundTruthDishes: dishes.length,
    stillLiveDishes: stillLive,
    scoredDishes: scored,
    correctDishes: correct,
    accuracyPct: scored > 0 ? (correct / scored) * 100 : null,
    confusion,
    unsafeMislabels,
    menuCandidates,
    missedMenus: evalCase.missedMenus ?? null,
  };
}

export async function scoreAll(): Promise<EvalCaseScore[]> {
  const cases = await getEvalCases();
  const scores: EvalCaseScore[] = [];
  for (const c of cases) {
    const score = await scoreEvalCase(c.id);
    if (score) scores.push(score);
  }
  return scores;
}

export function aggregateUnsafeCount(scores: EvalCaseScore[]): number {
  return scores.reduce((sum, s) => sum + s.unsafeMislabels.length, 0);
}

export function aggregateAccuracy(scores: EvalCaseScore[]): { correct: number; scored: number; pct: number | null } {
  const correct = scores.reduce((sum, s) => sum + s.correctDishes, 0);
  const scored = scores.reduce((sum, s) => sum + s.scoredDishes, 0);
  return { correct, scored, pct: scored > 0 ? (correct / scored) * 100 : null };
}
