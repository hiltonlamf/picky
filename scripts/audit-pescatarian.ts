// Audit the pescatarian rule (lib/dietary-overrides.ts) against every dish we
// have already analysed, across every restaurant in every city guide.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping. The rule is pure
// string matching over rows already in the database, which is the whole reason
// this feature needed no backfill — so this can be re-run as often as you like
// while tuning the word lists.
//
//   npx tsx scripts/audit-pescatarian.ts
//
// THE REPORT IS THE POINT. Two lists decide whether the rule is good enough:
//
//   1. CAUGHT — non-veg dishes the rule calls seafood. Read this for FALSE
//      POSITIVES. A meat dish in here is served to someone who does not eat
//      meat: the unsafe-mislabel class CLAUDE.md ranks with a security bug.
//      This list must be clean before the feature ships.
//
//   2. MISSED — non-veg dishes the rule does NOT call seafood. Read this for
//      RECALL. A fish dish in here merely goes missing from the pescatarian
//      tab, which is the same "under-promise" the veggie count already
//      prefers — annoying, not dangerous. If this list is mostly genuine meat,
//      the rules are doing their job and no AI pass is needed. If it is full of
//      fish we failed to recognise, that is the argument for spending on a
//      one-off Haiku pass over THESE DISHES ONLY.
//
// It also re-checks the veggie and vegan numbers, because widening the seafood
// word list also widens the safety override that forces a dish to 'neither' —
// so this branch can move the veggie count, and any movement should be a dish
// that genuinely names a fish.
//
// It talks to Supabase directly rather than importing lib/db, deliberately:
// lib/db pulls in the whole app graph (lib/scraper and friends), which takes
// minutes to load in this sandbox for a script that only needs three tables.
import './_preload-env';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { isSeafoodDish, effectiveDietaryClassification } from '@/lib/dietary-overrides';
import { menuTallies, guideInsights } from '@/lib/menu-insights';
import { modifierDishes } from '@/lib/menu-modifiers';
import type { Restaurant, MenuSection, Dish, DietaryClassification } from '@/types';

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

/** PostgREST silently truncates at 1000 rows, so every whole-table read pages.
 *  Mirrors selectAllRows in lib/db.ts, which is private to that module. */
async function selectAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // Retry the page, not the run: a single dropped connection partway through
    // 4,000 rows should not cost the whole audit (it did once).
    let page: T[] | null = null;
    for (let attempt = 1; attempt <= 4 && page === null; attempt++) {
      try {
        const { data, error } = await build(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        page = (data ?? []) as T[];
      } catch (err) {
        if (attempt === 4) throw err;
        console.log(`  page ${from} failed (${(err as Error).message}) — retry ${attempt}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    all.push(...page!);
    if (page!.length < PAGE) break;
  }
  return all;
}

interface DishRow {
  restaurant: string;
  city: string;
  section: string;
  name: string;
  description: string | null;
  /** What is stored on the row, before any display-time correction. */
  stored: string;
}

interface RestaurantReport {
  city: string;
  id: string;
  name: string;
  veg: number;
  pesc: number;
  /** Card figure vs page figure — these must agree, on every restaurant. */
  cardPesc: number;
  caught: DishRow[];
  missed: DishRow[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rowsTable(rows: DishRow[]): string {
  if (rows.length === 0) return '<p class="none">None.</p>';
  return (
    '<table><tr><th>Restaurant</th><th>Section</th><th>Dish</th><th>Description</th></tr>' +
    rows
      .map(
        (r) =>
          `<tr><td>${esc(r.restaurant)}</td><td>${esc(r.section)}</td>` +
          `<td><strong>${esc(r.name)}</strong></td>` +
          `<td class="desc">${esc((r.description ?? '').slice(0, 160))}</td></tr>`
      )
      .join('') +
    '</table>'
  );
}

function renderHtml(reports: RestaurantReport[]): string {
  const caught = reports.flatMap((r) => r.caught);
  const missed = reports.flatMap((r) => r.missed);
  const mismatches = reports.filter((r) => r.pesc !== r.cardPesc);
  return `<!doctype html><meta charset="utf-8"><title>Pescatarian rule audit</title>
<style>
 body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:1100px;color:#12261c}
 h1{font-size:1.6rem} h2{margin-top:2.5rem;border-bottom:2px solid #e4ece7;padding-bottom:.3rem}
 table{border-collapse:collapse;width:100%;margin:.75rem 0} th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eef2f0;vertical-align:top}
 th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:#5c7a6b}
 .desc{color:#5c7a6b;font-size:.85rem} .none{color:#5c7a6b;font-style:italic}
 .warn{background:#fff4f7;border:1px solid #ffd0e0;padding:.75rem 1rem;border-radius:8px}
 .ok{background:#eefaf3;border:1px solid #bfe6d2;padding:.75rem 1rem;border-radius:8px}
 code{background:#f2f6f4;padding:.1rem .3rem;border-radius:4px}
</style>
<h1>Pescatarian rule audit</h1>
<p>${reports.length} restaurants. <strong>${caught.length}</strong> non-veg dishes called seafood,
<strong>${missed.length}</strong> not.</p>

<div class="${mismatches.length === 0 ? 'ok' : 'warn'}">
${
  mismatches.length === 0
    ? 'Guide card and restaurant page agree on the pescatarian number for every restaurant.'
    : `<strong>${mismatches.length} restaurant(s) where the card and the page disagree — fix before shipping:</strong><br>` +
      mismatches.map((r) => `${esc(r.name)}: card ${r.cardPesc}, page ${r.pesc}`).join('<br>')
}
</div>

<h2>1. Caught as seafood — read this for false positives</h2>
<p>A <em>meat</em> dish in this list is the dangerous error: it would be shown to
someone who does not eat meat. This list should be all fish and shellfish.</p>
${rowsTable(caught)}

<h2>2. Not caught — read this for recall</h2>
<p>Non-veg dishes the rule left out of the pescatarian tab. Genuine meat here is
correct. <strong>Fish here is a miss</strong> — if there is a lot of it, that is
the case for a one-off AI pass over these dishes only.</p>
${rowsTable(missed)}

<h2>3. Per restaurant</h2>
<table><tr><th>City</th><th>Restaurant</th><th>Veggie</th><th>Pescatarian</th><th>Extra from seafood</th></tr>
${reports
  .map(
    (r) =>
      `<tr><td>${esc(r.city)}</td><td>${esc(r.name)}</td><td>${r.veg}</td><td>${r.pesc}</td><td>${
        r.pesc - r.veg
      }</td></tr>`
  )
  .join('')}
</table>`;
}

function auditRestaurant(restaurant: Restaurant, city: string): RestaurantReport {
  const caught: DishRow[] = [];
  const missed: DishRow[] = [];

  for (const section of restaurant.sections) {
    const modifiers = modifierDishes(section);
    for (const dish of section.dishes) {
      if (dish.deletedAt) continue;
      if (modifiers.has(dish)) continue;
      // Only non-veg dishes are ever tested — a veg dish is pescatarian by
      // definition and never touches the seafood word list.
      if (effectiveDietaryClassification(section.name, dish) !== 'neither') continue;
      const row: DishRow = {
        restaurant: restaurant.name ?? restaurant.url,
        city,
        section: section.name,
        name: dish.name,
        description: dish.description ?? null,
        stored: dish.classification,
      };
      (isSeafoodDish(section.name, dish) ? caught : missed).push(row);
    }
  }

  // Card vs page, compared on the SAME menu. The card headlines one menu (a
  // diner only eats from one), and the page opens on that same menu — so
  // comparing the card against a whole-restaurant total would report a
  // mismatch on every multi-menu restaurant and hide any real one.
  const { maxPescOptions, bestMenu } = guideInsights(restaurant);
  const bestSections = restaurant.sections.filter((s) => (s.menuLabel ?? null) === bestMenu.label);
  const tallies = menuTallies(
    bestSections.length > 0 ? bestSections : restaurant.sections,
    restaurant.sections
  );

  return {
    city,
    id: restaurant.id,
    name: restaurant.name ?? restaurant.url,
    veg: tallies.veg.counted,
    pesc: tallies.pesc.counted,
    cardPesc: maxPescOptions,
    caught,
    missed,
  };
}

/** Assemble Restaurant-shaped objects from three bulk reads, so the pure
 *  counting functions below see exactly what the app sees. Three queries
 *  total, not four per restaurant. */
async function loadRestaurants(): Promise<Restaurant[]> {
  const supabase = db();

  console.log('loading restaurants...');
  const rows = await selectAll<any>((from, to) =>
    supabase
      .from('restaurants')
      .select('id, name, url, city, status, cuisine')
      .eq('status', 'done')
      .range(from, to)
  );

  console.log(`loading sections and dishes for ${rows.length} restaurants...`);
  const sectionRows = await selectAll<any>((from, to) =>
    supabase.from('menu_sections').select('*').order('display_order').range(from, to)
  );
  const dishRows = await selectAll<any>((from, to) =>
    supabase.from('dishes').select('*').is('deleted_at', null).order('created_at').range(from, to)
  );
  console.log(`${sectionRows.length} sections, ${dishRows.length} live dishes\n`);

  const dishesBySection = new Map<string, Dish[]>();
  for (const d of dishRows) {
    const dish: Dish = {
      id: d.id,
      name: d.name,
      description: d.description,
      price: d.price,
      classification: d.classification as DietaryClassification,
      confidence: d.confidence,
      confidenceReason: d.confidence_reason,
      reportCount: d.report_count ?? 0,
      warningFlagged: !!d.warning_flagged,
      humanVerified: !!d.human_verified,
      origin: d.origin ?? 'ai',
      deletedAt: d.deleted_at ?? null,
    };
    const list = dishesBySection.get(d.section_id) ?? [];
    list.push(dish);
    dishesBySection.set(d.section_id, list);
  }

  const sectionsByRestaurant = new Map<string, MenuSection[]>();
  for (const s of sectionRows) {
    const section: MenuSection = {
      id: s.id,
      name: s.name,
      displayOrder: s.display_order ?? 0,
      menuLabel: s.menu_label ?? null,
      dishes: dishesBySection.get(s.id) ?? [],
    };
    const list = sectionsByRestaurant.get(s.restaurant_id) ?? [];
    list.push(section);
    sectionsByRestaurant.set(s.restaurant_id, list);
  }

  return rows.map((r) => ({
    ...r,
    sections: sectionsByRestaurant.get(r.id) ?? [],
  })) as Restaurant[];
}

async function main() {
  const restaurants = await loadRestaurants();
  const reports: RestaurantReport[] = [];
  for (const r of restaurants) {
    if (r.sections.length === 0) continue;
    reports.push(auditRestaurant(r, r.city ?? 'unknown'));
  }

  const outDir = join(process.cwd(), 'db', 'reports');
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, 'pescatarian-audit.html');
  writeFileSync(htmlPath, renderHtml(reports));

  const caught = reports.reduce((a, r) => a + r.caught.length, 0);
  const missed = reports.reduce((a, r) => a + r.missed.length, 0);
  const mismatches = reports.filter((r) => r.pesc !== r.cardPesc);

  console.log(`\n${reports.length} analysed restaurants`);
  console.log(`non-veg dishes called seafood: ${caught}`);
  console.log(`non-veg dishes NOT called seafood: ${missed}`);
  console.log(
    mismatches.length === 0
      ? 'card/page pescatarian figures agree everywhere ✅'
      : `⚠️  ${mismatches.length} card/page mismatches — see the report`
  );

  console.log('\ncity       veggie  pesc   +fish  restaurant');
  for (const r of reports) {
    console.log(
      `${r.city.padEnd(10)} ${String(r.veg).padStart(6)} ${String(r.pesc).padStart(5)} ${String(
        r.pesc - r.veg
      ).padStart(6)}  ${r.name}`
    );
  }
  console.log(`\nreport: ${htmlPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
