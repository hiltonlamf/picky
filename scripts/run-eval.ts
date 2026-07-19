/**
 * Free retrospective eval scoring — zero LLM calls.
 *
 *   npx tsx scripts/run-eval.ts
 *
 * Scores every eval_case's human-validated eval_dishes / eval_menu_candidates
 * (auto-grown from admin review + confirmed feedback) against whatever's
 * CURRENTLY LIVE for that restaurant's URL. This is a DB-only comparison —
 * it never calls the Anthropic API, so it's safe to run as often as you like.
 * A "fresh paid re-run" mode (score against a brand-new AI pass) is a
 * deliberate fast-follow, not v1 — see the plan file.
 */
import './_preload-env'; // MUST be first — loads env before lib modules evaluate

import { scoreAll, aggregateUnsafeCount, aggregateAccuracy } from '../lib/eval';

async function main() {
  console.log('Free retrospective eval scoring (0 LLM calls, $0.00) — scoring the golden set against live data...\n');

  const scores = await scoreAll();
  if (scores.length === 0) {
    console.log('No eval cases yet. Confirm/correct a dish (or review a menu candidate) in /admin to create one.');
    process.exit(0);
  }

  for (const s of scores) {
    console.log(`=== ${s.evalCase.name ?? '(unnamed)'} — ${s.evalCase.url} ===`);
    console.log(
      `  AI accuracy: ${s.accuracyPct !== null ? s.accuracyPct.toFixed(1) + '%' : 'n/a (no scored dishes yet)'} ` +
        `(${s.correctDishes}/${s.scoredDishes} dishes the AI originally guessed right vs the human verdict)`
    );
    if (s.liveFound) {
      console.log(`  coverage: ${s.stillLiveDishes}/${s.totalGroundTruthDishes} ground-truth dishes still present in the live menu`);
    } else {
      console.log('  coverage: no live restaurant for this URL (deleted, wiped, or never scraped)');
    }
    if (s.scoredDishes > 0) {
      console.log('  confusion matrix (rows = human verdict, cols = AI original guess):');
      const classes: Array<keyof typeof s.confusion> = ['vegan', 'vegetarian', 'neither', 'unknown'];
      console.log('    ' + ['human\\ai', ...classes].map((c) => String(c).padEnd(12)).join(''));
      for (const expected of classes) {
        const row = classes.map((actual) => String(s.confusion[expected][actual]).padEnd(12));
        console.log('    ' + expected.padEnd(12).slice(0, 12) + row.join(''));
      }
    }

    if (s.unsafeMislabels.length > 0) {
      console.log(`  \u{1F6A8} UNSAFE: ${s.unsafeMislabels.length} dish(es) a human marked 'neither' that the AI originally called vegan/vegetarian:`);
      for (const u of s.unsafeMislabels) console.log(`     - "${u.dishName}" -> AI guessed: ${u.aiClassification}`);
    }

    if (s.menuCandidates.length > 0) {
      const spurious = s.menuCandidates.filter((c) => c.verdict === 'spurious').length;
      const duplicate = s.menuCandidates.filter((c) => c.verdict === 'duplicate').length;
      console.log(
        `  menu candidates reviewed: ${s.menuCandidates.length} (spurious: ${spurious}, duplicate: ${duplicate})`
      );
    }
    if (s.missedMenus) console.log(`  missed menus noted: ${s.missedMenus}`);
    console.log('');
  }

  const { correct, scored, pct } = aggregateAccuracy(scores);
  const totalUnsafe = aggregateUnsafeCount(scores);

  console.log('================ SUMMARY ================');
  console.log(`  eval cases: ${scores.length}`);
  console.log(`  overall AI dish accuracy: ${pct !== null ? pct.toFixed(1) + '%' : 'n/a'} (${correct}/${scored} dishes AI guessed right)`);
  console.log(`  UNSAFE mislabels (human said 'neither', AI originally guessed vegan/vegetarian): ${totalUnsafe}`);
  console.log('  cost: $0.00 — free retrospective scoring of the golden set, no LLM calls made.');
  process.exit(0);
}

main().catch((err) => {
  console.error('EVAL RUN FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
