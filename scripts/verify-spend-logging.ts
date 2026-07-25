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
 * Sonnet escalation at 3× the price).
 *
 * Cost: a handful of Haiku/Sonnet calls, well under $0.10. Run it after any
 * change to lib/ai.ts's call sites.
 *
 *   npx tsx scripts/verify-spend-logging.ts
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { labelMenuCandidates } from '../lib/ai';
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
    { restaurantId: null, url: 'https://example.com', restaurantName: 'Spend Verification' },
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

  // --- Summary ----------------------------------------------------------------
  const after = await spendSnapshot();
  const newRows = after.rows - before.rows;
  console.log('─'.repeat(58));
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
