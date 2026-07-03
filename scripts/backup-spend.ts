/**
 * Export the API-spend record (cost columns on `restaurants`) to a timestamped
 * CSV under db/spend-backups/.
 *
 * WHY: cost history is how we track whether this project is affordable, and it
 * currently lives ON the restaurant rows — so "wipe the database" would destroy
 * it (this happened on 2026-07-02). Run this before ANY wipe; wipe-menus.ts
 * runs it automatically and refuses to delete anything if the backup fails.
 *
 * Usage: npx tsx scripts/backup-spend.ts
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

async function main(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing — check .env.local');
  const db = createClient(url, key);

  const { data, error } = await db
    .from('restaurants')
    .select('id, name, url, status, model_used, tokens_in, tokens_out, cost_usd, last_scraped_at, created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to read restaurants: ${error.message}`);

  const rows = data ?? [];
  const dir = path.join(process.cwd(), 'db', 'spend-backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-spend.csv`);

  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'id,name,url,status,model_used,tokens_in,tokens_out,cost_usd,last_scraped_at,created_at';
  const body = rows.map((r) =>
    [r.id, r.name, r.url, r.status, r.model_used, r.tokens_in, r.tokens_out, r.cost_usd, r.last_scraped_at, r.created_at]
      .map(esc)
      .join(',')
  );
  fs.writeFileSync(file, [header, ...body].join('\n') + '\n');

  const total = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  console.log(`Backed up ${rows.length} restaurant rows (total recorded spend $${total.toFixed(4)}) → ${file}`);
  return file;
}

main().catch((err) => {
  console.error('SPEND BACKUP FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
