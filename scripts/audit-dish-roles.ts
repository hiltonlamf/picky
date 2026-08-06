// Audit what the dish-role rule (lib/dish-role.ts) would exclude from the
// "N veggie" headline, across every restaurant in every city guide.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping. It re-reads what
// is already in the database and applies pure string rules, so it can be run as
// often as you like while tuning the keyword lists.
//
//   npx tsx scripts/audit-dish-roles.ts            # console summary + HTML
//   npx tsx scripts/audit-dish-roles.ts --open     # also print the file path
//
// The HTML report is the thing to actually look at: every excluded dish grouped
// by the rule that caught it, plus the "ambiguous" band — dishes we are still
// counting that a human might not, which is the list we use to decide whether
// an AI-labelled second tier is worth adding.
import './_preload-env';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getCityGuides, getFeaturedRestaurants } from '@/lib/db';
import { classifyDishRole, type DishRole } from '@/lib/dish-role';
import { parsePrice, headlineCounts, makeCountedTest } from '@/lib/menu-insights';
import { formatPrice } from '@/lib/format-price';
import type { Restaurant, MenuSection } from '@/types';

interface DishRow {
  section: string;
  menuLabel: string | null;
  name: string;
  price: string | null;
  numericPrice: number | null;
  classification: string;
  role: DishRole;
  rule: string | null;
  /** Counted, but sitting somewhere that makes it worth a second look. */
  ambiguous: boolean;
  ambiguousWhy: string | null;
}

interface RestaurantReport {
  city: string;
  id: string;
  name: string;
  before: number;
  after: number;
  aside: number;
  excluded: DishRow[];
  ambiguous: DishRow[];
}

// Sections whose name suggests the dish might not be a main. Used ONLY to build
// the "worth a second look" list in this report — never to exclude anything.
const SOFT_SECTION_HINTS = [
  'side', 'snack', 'nibble', 'bite', 'dip', 'condiment', 'extra', 'accompaniment',
  'tapas', 'pinxto', 'pintxo', 'sharing', 'bread', 'rice', 'dim sum', 'xiao chi',
];

const isVeg = (c: string) => c === 'vegan' || c === 'vegetarian' || c === 'unknown';

/**
 * Before/after headline figures for one restaurant.
 *
 * `before` is computed here from scratch and deliberately does NOT call
 * guideInsights: that function now applies the role rule, so using it would
 * compare the new behaviour against itself and report "no change" for every
 * restaurant. `before` is the OLD definition — every veg dish on the best
 * single menu, sides and sweets included.
 *
 * `after` MUST come from headlineCounts, the same function the guide card and
 * restaurant page call. An earlier version of this counted `role === 'counted'`
 * by hand, which skipped both the de-duplication and the price tiebreak and so
 * reported Rasam as 15 where the site shows 13. A review artifact that
 * disagrees with the product is worse than no artifact.
 */
function headlineFigures(r: Restaurant): { before: number; after: number; aside: number } {
  const byLabel = new Map<string | null, MenuSection[]>();
  const rawTotals = new Map<string | null, number>();
  for (const s of r.sections) {
    const k = s.menuLabel ?? null;
    byLabel.set(k, (byLabel.get(k) ?? []).concat(s));
    for (const d of s.dishes) {
      if (d.deletedAt || !isVeg(d.classification)) continue;
      rawTotals.set(k, (rawTotals.get(k) ?? 0) + 1);
    }
  }
  if (!rawTotals.size) return { before: 0, after: 0, aside: 0 };

  const before = Math.max(...Array.from(rawTotals.values()));
  // The "best" menu is the one with the most COUNTED options — same tie-break
  // the guide card uses, so the aside figure belongs to the menu on show.
  let best = { counted: 0, aside: 0 };
  byLabel.forEach((sections) => {
    const h = headlineCounts(sections, r.sections);
    if (h.counted > best.counted) best = { counted: h.counted, aside: h.aside };
  });
  return { before, after: best.counted, aside: best.aside };
}

function buildReport(city: string, r: Restaurant): RestaurantReport {
  // Bottom-quartile price within this restaurant — a cheap veg item in a
  // side-ish section is the classic "is this really a dish?" case.
  const prices = r.sections
    .flatMap((s) => s.dishes)
    .map((d) => parsePrice(d.price))
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const q1 = prices.length >= 4 ? prices[Math.floor(prices.length * 0.25)] : null;

  const excluded: DishRow[] = [];
  const ambiguous: DishRow[] = [];

  // The product's verdict, price tiebreak included — not the raw name verdict,
  // which would list Fade Street's €20.50 flatbread as excluded when the guide
  // counts it.
  const counts = makeCountedTest(r.sections);

  for (const s of r.sections) {
    for (const d of s.dishes) {
      if (d.deletedAt || !isVeg(d.classification)) continue;
      const verdict = classifyDishRole(s.name, d);
      const numericPrice = parsePrice(d.price);
      const base = {
        section: s.name,
        menuLabel: s.menuLabel ?? null,
        name: d.name,
        price: formatPrice(d.price),
        numericPrice,
        classification: d.classification,
        role: verdict.role,
        rule: verdict.rule,
      };

      if (!counts(s.name, d)) {
        excluded.push({
          ...base,
          // A name-ambiguous dish that price demoted: say so, it's the case the
          // founder is most likely to want to argue with.
          rule: verdict.ambiguous ? `${verdict.rule ?? 'ambiguous'} + cheap for this menu` : verdict.rule,
          ambiguous: false,
          ambiguousWhy: null,
        });
        continue;
      }

      const sectionHint = SOFT_SECTION_HINTS.find((h) => s.name.toLowerCase().includes(h));
      const cheap = q1 !== null && numericPrice !== null && numericPrice <= q1;
      if (sectionHint || cheap) {
        const why = [
          sectionHint ? `in a "${s.name}" section` : null,
          cheap ? `cheapest quarter of this menu` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        ambiguous.push({ ...base, ambiguous: true, ambiguousWhy: why });
      }
    }
  }

  return {
    city,
    id: r.id,
    name: r.name ?? 'Restaurant',
    ...headlineFigures(r),
    excluded,
    ambiguous,
  };
}

// ------------------------------------------------------------------- render

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROLE_LABEL: Record<Exclude<DishRole, 'counted'>, string> = {
  dessert: 'Desserts',
  condiment: 'Sauces & condiments',
  staple: 'Breads, rice & bar staples',
};

function renderDishList(rows: DishRow[]): string {
  return rows
    .map(
      (d) => `<li>
        <span class="dish">${esc(d.name)}</span>
        ${d.price ? `<span class="price">${esc(d.price)}</span>` : ''}
        <span class="meta">${esc(d.section)}${d.menuLabel ? ` · ${esc(d.menuLabel)}` : ''}</span>
        ${d.rule ? `<span class="rule">${esc(d.rule)}</span>` : ''}
        ${d.ambiguousWhy ? `<span class="rule warn">${esc(d.ambiguousWhy)}</span>` : ''}
      </li>`
    )
    .join('');
}

/** How hard this restaurant is hit, used for the card's severity stripe.
 *  State should read at a glance, not only from the digits. */
function severity(rep: RestaurantReport): string {
  const drop = rep.before - rep.after;
  if (rep.before > 0 && rep.after === 0) return 'zero';
  if (drop >= 6) return 'high';
  if (drop >= 3) return 'mid';
  if (drop > 0) return 'low';
  return 'none';
}

function renderRestaurant(rep: RestaurantReport): string {
  const byRole = (['dessert', 'condiment', 'staple'] as const)
    .map((role) => {
      const rows = rep.excluded.filter((d) => d.role === role);
      if (!rows.length) return '';
      return `<div class="group"><h4>${ROLE_LABEL[role]} <span class="n">${rows.length}</span></h4>
        <ul class="dishes">${renderDishList(rows)}</ul></div>`;
    })
    .join('');

  const amb = rep.ambiguous.length
    ? `<div class="group ambiguous"><h4>Still counted — worth a second look <span class="n">${rep.ambiguous.length}</span></h4>
       <ul class="dishes">${renderDishList(rep.ambiguous)}</ul></div>`
    : '';

  const delta = rep.before - rep.after;
  return `<section class="rest sev-${severity(rep)}">
    <header>
      <h3>${esc(rep.name)}</h3>
      <div class="counts">
        <span class="was">${rep.before}</span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="now">${rep.after}</span>
        <span class="unit">veggie</span>
        ${rep.aside ? `<span class="aside">+${rep.aside} sides &amp; sweets</span>` : ''}
        ${delta ? `<span class="delta">−${delta}</span>` : '<span class="nochange">unchanged</span>'}
      </div>
      <div class="city">${esc(rep.city)}</div>
    </header>
    ${byRole}${amb}
  </section>`;
}

function renderHtml(reports: RestaurantReport[]): string {
  const moved = reports.filter((r) => r.before !== r.after);
  const totalBefore = reports.reduce((a, r) => a + r.before, 0);
  const totalAfter = reports.reduce((a, r) => a + r.after, 0);
  const totalExcluded = reports.reduce((a, r) => a + r.excluded.length, 0);
  const totalAmbiguous = reports.reduce((a, r) => a + r.ambiguous.length, 0);
  const zeroed = reports.filter((r) => r.before > 0 && r.after === 0);

  return `<title>Veggie count audit — what we stop counting</title>
<style>
  /* Picky's own system (tailwind.config.ts / globals.css): forest green ground,
     azalea pink accent, and monospace reserved for "the AI layer" — here that
     means the rule names, which literally are machine output. Neutrals are
     biased green rather than pure grey so they belong to the brand. */
  :root {
    --bg: #f7f6f0; --card: #fffffe; --ink: #10291f; --ink-2: #10291fb0;
    --ink-3: #10291f7a; --line: #10291f1f;
    --green: #0b6d49; --pink: #c8106f; --amber: #96560a;
    --wash: #10291f0a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a1811; --card: #10241b; --ink: #e9f2ec; --ink-2: #e9f2ecb8;
      --ink-3: #e9f2ec80; --line: #e9f2ec1f;
      --green: #4fd79c; --pink: #ff6bb0; --amber: #e5a655;
      --wash: #e9f2ec0a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0a1811; --card: #10241b; --ink: #e9f2ec; --ink-2: #e9f2ecb8;
    --ink-3: #e9f2ec80; --line: #e9f2ec1f;
    --green: #4fd79c; --pink: #ff6bb0; --amber: #e5a655;
    --wash: #e9f2ec0a;
  }
  :root[data-theme="light"] {
    --bg: #f7f6f0; --card: #fffffe; --ink: #10291f; --ink-2: #10291fb0;
    --ink-3: #10291f7a; --line: #10291f1f;
    --green: #0b6d49; --pink: #c8106f; --amber: #96560a;
    --wash: #10291f0a;
  }

  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); margin: 0;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 60rem; margin: 0 auto; padding: clamp(2rem, 6vw, 3.5rem) 1.25rem 6rem;
    display: flex; flex-direction: column; }

  .eyebrow { font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-size: .7rem; text-transform: uppercase; letter-spacing: .14em; color: var(--pink);
    margin: 0 0 .75rem; }
  h1 { font-size: clamp(1.75rem, 4.5vw, 2.6rem); line-height: 1.05; letter-spacing: -0.03em;
    margin: 0 0 .75rem; text-wrap: balance; max-width: 20ch; }
  .lede { color: var(--ink-2); max-width: 64ch; margin: 0 0 2.25rem; font-size: 1.02rem; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: .7rem; margin-bottom: 1.5rem; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .15rem; }
  .tile b { font-size: 1.8rem; line-height: 1.05; letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums; font-weight: 650; }
  .tile span { color: var(--ink-3); font-size: .78rem; line-height: 1.35; }

  .note { border-left: 2px solid var(--pink); padding: .35rem 0 .35rem 1rem;
    margin: 0 0 2.5rem; color: var(--ink-2); max-width: 64ch; font-size: .92rem; }
  .note strong { color: var(--ink); }

  h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; letter-spacing: -0.015em;
    display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  h2 .sub { font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-weight: 400; color: var(--ink-3); font-size: .72rem; text-transform: uppercase;
    letter-spacing: .1em; }

  /* The stripe encodes how hard the restaurant is hit, so severity reads before
     the digits do. */
  .rest { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--line);
    border-radius: 12px; padding: 1rem 1.15rem; margin-bottom: .7rem; }
  .rest.sev-zero { border-left-color: var(--pink); }
  .rest.sev-high { border-left-color: color-mix(in oklab, var(--pink) 70%, transparent); }
  .rest.sev-mid  { border-left-color: color-mix(in oklab, var(--pink) 42%, transparent); }
  .rest.sev-low  { border-left-color: color-mix(in oklab, var(--pink) 20%, transparent); }

  .rest header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .4rem .9rem; }
  .rest h3 { margin: 0; font-size: 1rem; letter-spacing: -0.015em; font-weight: 600; }
  .counts { display: flex; align-items: baseline; gap: .4rem; font-variant-numeric: tabular-nums; }
  .was { color: var(--ink-3); text-decoration: line-through; text-decoration-thickness: 1px; }
  .now { color: var(--green); font-weight: 700; font-size: 1.2rem; letter-spacing: -0.02em; }
  .arrow { color: var(--ink-3); }
  .unit { color: var(--ink-3); font-size: .8rem; }
  .aside, .delta, .nochange { font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-size: .7rem; }
  .aside { color: var(--ink-3); }
  .delta { color: var(--pink); font-weight: 600; }
  .nochange { color: var(--ink-3); }
  .city { margin-left: auto; color: var(--ink-3); font-size: .68rem; text-transform: uppercase;
    letter-spacing: .12em;
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; }

  .group { margin-top: .9rem; }
  .group h4 { margin: 0 0 .4rem; font-size: .68rem; text-transform: uppercase;
    letter-spacing: .12em; color: var(--ink-3); font-weight: 600;
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    display: flex; align-items: center; gap: .5rem; }
  .group h4 .n { color: var(--pink); }
  .group.ambiguous h4 { color: var(--amber); }
  .group.ambiguous h4 .n { color: var(--amber); }

  ul.dishes { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
  ul.dishes li { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem;
    padding: .38rem .6rem; border-radius: 7px; background: var(--wash); }
  .dish { font-weight: 500; }
  .price { color: var(--ink-3); font-variant-numeric: tabular-nums; font-size: .82rem;
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; }
  .meta { color: var(--ink-3); font-size: .78rem; }
  .rule { margin-left: auto; color: var(--ink-3); font-size: .7rem;
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    white-space: nowrap; }
  .rule.warn { color: var(--amber); white-space: normal; }

  @media (max-width: 680px) {
    .rule { margin-left: 0; width: 100%; white-space: normal; }
    .city { margin-left: 0; width: 100%; }
  }
</style>
<div class="wrap">
<p class="eyebrow">Verification · dish-role rule · ${new Date().toISOString().slice(0, 10)}</p>
<h1>What we stop counting as a “veggie option”</h1>
<p class="lede">Every dish the new rule removes from the headline count on the city guide
and restaurant pages, grouped by the rule that caught it. Nothing here is hidden from
diners — these dishes still appear on the menu, they just stop inflating the number.</p>

<div class="tiles">
  <div class="tile"><b>${totalBefore} → ${totalAfter}</b><span>headline veggie total, all guides</span></div>
  <div class="tile"><b>${totalExcluded}</b><span>dish entries excluded</span></div>
  <div class="tile"><b>${moved.length}</b><span>restaurants whose number changes</span></div>
  <div class="tile"><b>${totalAmbiguous}</b><span>still counted, worth a look</span></div>
</div>

<p class="note"><strong>How to read this.</strong> The pink items are what the rule removed —
check for anything that is genuinely a dish. The amber “worth a second look” items are ones we
chose to <em>keep</em>, because when in doubt we count rather than undercount; that list is what
we would hand to an AI second tier if we decide it is worth it.
${zeroed.length ? `<br><br><strong>${zeroed.length} restaurant${zeroed.length === 1 ? '' : 's'} drop${zeroed.length === 1 ? 's' : ''} to zero:</strong> ${esc(zeroed.map((z) => `${z.name} (${z.before}→0)`).join(', '))}. Those cards need honest copy rather than a bare 0.` : ''}</p>

<h2>Restaurants that change <span class="sub">biggest movers first</span></h2>
${moved.map(renderRestaurant).join('')}

<h2>Unchanged <span class="sub">the rule found nothing to remove</span></h2>
${reports.filter((r) => r.before === r.after).map(renderRestaurant).join('')}
</div>`;
}

// --------------------------------------------------------------------- main

async function main() {
  const guides = await getCityGuides();
  const reports: RestaurantReport[] = [];

  for (const g of guides) {
    const restaurants = await getFeaturedRestaurants(g.slug, { includeHidden: false });
    for (const r of restaurants) {
      if (r.status !== 'done') continue;
      reports.push(buildReport(g.slug, r));
    }
  }

  reports.sort((a, b) => b.before - b.after - (a.before - a.after));

  const outDir = join(process.cwd(), 'db', 'reports');
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, 'dish-role-audit.html');
  writeFileSync(htmlPath, renderHtml(reports));

  // Console summary — enough to sanity-check without opening the report.
  const totalBefore = reports.reduce((a, r) => a + r.before, 0);
  const totalAfter = reports.reduce((a, r) => a + r.after, 0);
  console.log(`\n${reports.length} analysed restaurants across ${guides.length} guides`);
  console.log(`headline veggie total: ${totalBefore} → ${totalAfter}\n`);
  console.log('city       before  after  aside  restaurant');
  for (const r of reports) {
    const flag = r.before > 0 && r.after === 0 ? '  ← ZERO' : '';
    console.log(
      `${r.city.padEnd(10)} ${String(r.before).padStart(6)} ${String(r.after).padStart(6)} ${String(r.aside).padStart(6)}  ${r.name}${flag}`
    );
  }
  const amb = reports.reduce((a, r) => a + r.ambiguous.length, 0);
  console.log(`\nexcluded dish entries: ${reports.reduce((a, r) => a + r.excluded.length, 0)}`);
  console.log(`still counted but worth a look: ${amb}`);
  console.log(`\nreport: ${htmlPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
