/**
 * Deletes parse_attempts rows older than the retention window (180 days,
 * founder's decision 2026-07-25).
 *
 * url + anon_id together are pseudonymous personal data, so they should not be
 * kept indefinitely. Run periodically — monthly is ample at current volume.
 *
 *   npx tsx scripts/prune-parse-attempts.ts          # dry run: shows the count
 *   npx tsx scripts/prune-parse-attempts.ts --yes    # actually delete
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';

const RETAIN_DAYS = 180;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000).toISOString();

  const { count } = await supabase
    .from('parse_attempts')
    .select('*', { count: 'exact', head: true })
    .lt('created_at', cutoff);

  console.log(`retention: ${RETAIN_DAYS} days (cutoff ${cutoff.slice(0, 10)})`);
  console.log(`rows older than the window: ${count ?? 0}`);

  if (!process.argv.includes('--yes')) {
    console.log('\nDry run. Re-run with --yes to delete.');
    return;
  }
  if (!count) {
    console.log('Nothing to delete.');
    return;
  }

  const { error } = await supabase.from('parse_attempts').delete().lt('created_at', cutoff);
  if (error) throw new Error(error.message);
  console.log(`deleted ${count} row(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
