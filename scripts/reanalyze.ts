// Re-run the existing analysis engine (parseAndSave) for specific restaurants —
// e.g. after a discovery/scraper fix, to pick up menus we previously missed.
// Spends real AI money, so it's --yes-gated.
//
//   npx tsx scripts/reanalyze.ts https://oldstreet.ie            # dry (plan only)
//   npx tsx scripts/reanalyze.ts --yes https://oldstreet.ie      # execute
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import { findExistingRestaurant, fetchRestaurantWithDishes } from '../lib/db';
import { parseAndSave } from '../lib/init-dublin';

const APPLY = process.argv.includes('--yes');
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function main() {
  if (urls.length === 0) {
    console.log('Usage: npx tsx scripts/reanalyze.ts [--yes] <url> [<url> ...]');
    return;
  }
  const supabase = db();
  const runStart = new Date().toISOString();
  console.log(`${APPLY ? '⚙️  APPLY' : '🔎 DRY'} — re-analyse ${urls.length} restaurant(s)\n`);

  for (const url of urls) {
    const existing = await findExistingRestaurant(url);
    if (!existing) {
      console.log(`  ✗ ${url} — not in DB (skipped)`);
      continue;
    }
    const { data: row } = await supabase.from('restaurants').select('name').eq('id', existing.id).maybeSingle();
    const name = (row as { name: string | null } | null)?.name ?? url;
    if (!APPLY) {
      console.log(`  would re-analyse ${name} (${url})`);
      continue;
    }
    process.stdout.write(`  • ${name} … `);
    try {
      await parseAndSave(existing.id, name, url);
      const r = await fetchRestaurantWithDishes(existing.id);
      const labels = Array.from(new Set((r?.sections ?? []).map((s) => s.menuLabel).filter(Boolean)));
      const dishes = (r?.sections ?? []).flatMap((s) => s.dishes).length;
      console.log(`${r?.status}, ${dishes} dishes, menus: [${labels.join(', ') || 'single'}]`);
    } catch (err) {
      console.log(`error: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  if (APPLY) {
    const { data: usage } = await supabase.from('ai_usage_log').select('cost_usd').gte('created_at', runStart);
    const spend = (usage ?? []).reduce((s, u) => s + (Number(u.cost_usd) || 0), 0);
    console.log(`\nLogged AI spend: $${spend.toFixed(4)}.`);
  } else {
    console.log('\nRe-run with --yes to execute (spends real money).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
