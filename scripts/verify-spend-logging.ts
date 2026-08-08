/**
 * Proves that every Anthropic call reaches ai_usage_log — including the failure
 * paths that used to drop their spend silently.
 *
 * Why this script exists: July's logged spend was ~8× under the Console. The
 * cause was that extraction helpers returned `null` on failure, a shape that
 * cannot carry usage, so already-billed calls were never recorded. That class of
 * bug is invisible to unit tests and to a green build — the only way to catch it
 * is to make real calls and reconcile the row count and totals afterwards.
 *
 * It deliberately includes a case that FAILS extraction, because the failure path
 * is the one that was broken and the one that costs the most (Haiku fails →
 * Sonnet escalation at 3× the price). That case checks BOTH directions: the row
 * reaches ai_usage_log, and the failure reports the same spend to its caller.
 * Those are different bugs — PR #27 hit each of them separately.
 *
 * Cost: a handful of Haiku/Sonnet calls, well under $0.10. Run it after any
 * change to lib/ai.ts's call sites.
 *
 *   npx tsx scripts/verify-spend-logging.ts
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { labelMenuCandidates } from '../lib/ai';
import { extractAndMerge, ExtractionError } from '../lib/menu-extract';
import { withSpendContext } from '../lib/ai-spend';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Row = { cost_usd: number | null; model_used: string | null; tokens_in: number | null };

async function spendSnapshot(): Promise<{ rows: number; total: number }> {
  const { data } = await supabase.from('ai_usage_log').select('cost_usd');
  const rows = (data ?? []) as Row[];
  return {
    rows: rows.length,
    total: rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0),
  };
}

async function main() {
  const before = await spendSnapshot();
  console.log(`ai_usage_log before: ${before.rows} rows, $${before.total.toFixed(4)}\n`);

  // --- Case 1: a normal discovery-labelling call ------------------------------
  // This is labelMenuCandidates, one of the sites that previously recorded
  // NOTHING at all despite running on every single analysis.
  console.log('Case 1 — labelMenuCandidates (previously never logged)');
  await withSpendContext(
    { restaurantId: null, url: 'https://example.com', restaurantName: 'Spend Verification', source: 'qa' },
    async () => {
      await labelMenuCandidates(
        [
          { id: 'a', type: 'subpage', url: 'https://example.com/lunch', label: 'Lunch' },
          { id: 'b', type: 'pdf', url: 'https://example.com/dinner.pdf', label: 'Dinner' },
        ] as never,
        'Spend Verification'
      );
    }
  );
  const afterLabel = await spendSnapshot();
  const labelDelta = afterLabel.rows - before.rows;
  console.log(
    labelDelta > 0
      ? `  PASS — ${labelDelta} row(s) written, +$${(afterLabel.total - before.total).toFixed(6)}\n`
      : `  FAIL — no row written; this call is still invisible spend\n`
  );

  // --- Case 2: an extraction that FAILS --------------------------------------
  // The header has always promised this case; the code never had it, so the one
  // path that actually lost money went unchecked. It broke twice in PR #27
  // alone: run #33 reported "$0.0000 spent" on real calls, and run #40 did it
  // again one layer up, because spend was read off a value that is null when
  // every rung of the ladder fails. Failure is the most expensive path in this
  // pipeline — a ladder that escalates Haiku to Sonnet is 3x the price — so a
  // verification that only covers the happy path verifies the cheap half.
  console.log('Case 2 — an extraction where every attempt fails (the costly path)');
  const beforeFail = await spendSnapshot();
  let reportedCost = 0;
  await withSpendContext(
    { restaurantId: null, url: 'https://example.com/none', restaurantName: 'Spend Verification (failing)', source: 'qa' },
    async () => {
      try {
        await extractAndMerge(
          [{ id: 'x', type: 'text', label: 'Menu', ref: '', source: 'homepage' }],
          // Deliberately not a menu: the model will find no dishes, so every
          // rung is billed and none of them can succeed.
          { title: 'Spend Verification', inlineText: 'This page is about our history and our team. '.repeat(20) }
        );
        console.log('  (unexpected: extraction succeeded — the assertion below still applies)');
      } catch (err) {
        if (err instanceof ExtractionError) reportedCost = err.usage?.costUsd ?? 0;
        else throw err;
      }
    }
  );
  const afterFail = await spendSnapshot();
  const failRows = afterFail.rows - beforeFail.rows;
  const failLogged = afterFail.total - beforeFail.total;
  console.log(`  ledger  : ${failRows} row(s), +$${failLogged.toFixed(6)}`);
  console.log(`  reported: $${reportedCost.toFixed(6)} (what the failure told its caller it cost)`);
  if (failRows === 0) {
    console.log('  FAIL — a billed failure wrote nothing to the ledger\n');
  } else if (reportedCost <= 0) {
    console.log('  FAIL — the failure reported $0 while the ledger recorded real spend\n');
  } else {
    console.log('  PASS — the failure both recorded AND reported its spend\n');
  }

  // --- Summary ----------------------------------------------------------------
  const after = await spendSnapshot();
  const newRows = after.rows - before.rows;
  // Banner text matters: the workflow lifts everything after "SUMMARY" into the
  // PR comment, so without it the result arrives as an empty code block.
  console.log('\n================ SUMMARY ================');
  console.log(`rows added : ${newRows}`);
  console.log(`spend added: $${(after.total - before.total).toFixed(6)}`);
  console.log('─'.repeat(58));

  if (newRows === 0) {
    console.error('\nFAIL: no spend rows written. The choke point is not wired up.');
    process.exit(1);
  }

  const { data: recent } = await supabase
    .from('ai_usage_log')
    .select('model_used, tokens_in, tokens_out, cost_usd, restaurant_name')
    .order('created_at', { ascending: false })
    .limit(newRows);
  console.log('\nrows just written:');
  for (const r of (recent ?? []) as Array<Record<string, unknown>>) {
    console.log(
      `  ${r.model_used}  in=${r.tokens_in} out=${r.tokens_out}  $${Number(r.cost_usd).toFixed(6)}  (${r.restaurant_name ?? 'unattributed'})`
    );
  }

  console.log(
    '\nNOTE: reconcile this delta against the Anthropic Console for the same window.' +
    '\nThey should now match; before this fix, failure paths contributed $0.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
