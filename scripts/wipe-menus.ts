/**
 * Wipe analysed restaurants and their menus (sections/dishes/reports cascade)
 * for fresh testing — SAFELY.
 *
 * "Wipe the database" never includes spend/monitoring data: this script first
 * runs backup-spend.ts and refuses to delete anything if that backup fails.
 * The featured Dublin list re-seeds itself on next server start
 * (instrumentation.ts → init-dublin), so deleting everything is fine.
 *
 * Usage: npx tsx scripts/wipe-menus.ts --yes
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to wipe without --yes (this deletes every restaurant, section, and dish).');
    process.exit(1);
  }

  // Preserve the spend record FIRST — abort the wipe if this fails.
  execFileSync('npx', ['tsx', 'scripts/backup-spend.ts'], { stdio: 'inherit' });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing — check .env.local');
  const db = createClient(url, key);

  const { count: before } = await db.from('restaurants').select('*', { count: 'exact', head: true });
  // Cascades: menu_sections, dishes, dish_reports, featured_restaurants, menu_candidates.
  const { error } = await db.from('restaurants').delete().not('id', 'is', null);
  if (error) throw new Error(`Wipe failed: ${error.message}`);
  const { count: after } = await db.from('restaurants').select('*', { count: 'exact', head: true });

  console.log(`Deleted ${(before ?? 0) - (after ?? 0)} restaurants (and their menus/dishes). Remaining: ${after ?? 0}.`);
}

main().catch((err) => {
  console.error('WIPE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
