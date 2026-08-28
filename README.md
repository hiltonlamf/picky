# Platefully 🌱

**Find veggie dishes in any restaurant, instantly. AI-assisted. Human-verified.**

Platefully helps vegetarians and vegans work out what they can actually eat at a
restaurant before they leave home. Search a Dublin restaurant by name or paste
any restaurant link, and it finds the menus, reads every dish, and tells you
which ones are vegan, vegetarian, or neither — with a person reviewing the
classifications before they are published.

Live at **[platefully.vercel.app](https://platefully.vercel.app)**.

---

## Getting started

### 1. Install

```bash
npm install
```

### 2. Environment

```bash
cp .env.local.example .env.local
```

| Variable | Required | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase → Project Settings → API |
| `ADMIN_PASSWORD` | yes | Any strong secret — gates `/admin` |
| `IP_HASH_SALT` | yes | Any random string. Salts the hashed IPs used for rate limiting — with a known salt those hashes are reversible |
| `NEXT_PUBLIC_APP_URL` | yes | The site's own origin; used for canonical URLs and OG images |
| `JINA_API_KEY` / `FIRECRAWL_API_KEY` | recommended | Page readers for JavaScript-rendered menus |
| `GOOGLE_PLACES_API_KEY` | optional | Live restaurant-name lookup. Without it, database search and pasted links still work |
| `DAILY_SPEND_CAP_USD` | optional | Global daily AI ceiling. Defaults to 25 |
| `RATE_LIMIT_MAX_PER_HOUR` | optional | New-restaurant analyses per IP per hour. Defaults to 15 |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_SENTRY_DSN` | optional | Analytics and error tracking |

> If you enable Places, restrict the key to that API and set a Google Cloud
> budget alert — it is billed per request.

### 3. Database

Create a [Supabase](https://supabase.com) project (Frankfurt for EU data
residency), then run [`db/schema.sql`](db/schema.sql) in the SQL editor. It
creates every table with Row-Level Security enabled and **no policies**, which
is deliberate — see [Security](#security).

### 4. Run

```bash
npm run dev            # http://localhost:3000
npx tsx scripts/seed-dublin.ts   # optional: seed the Dublin guide
```

---

## How it works

The pipeline is three stages, and each is tuned around the fact that **finding
the menu is the hard part** — roughly 97% of AI spend goes on discovery and
extraction, not on classifying dishes.

1. **Discovery** — scrape the site and gather candidate menus (page text, PDFs,
   photos, subpages). A cheap Haiku call labels them ("Lunch", "Dinner"), drops
   wine lists, and de-duplicates the same menu in different formats. Sites with
   several menus show a picker; single-menu sites go straight through.
2. **Extraction** — one AI call reads the chosen menu and classifies every dish.
   If the result fails validation (too few items, header-like junk), a retry
   ladder tries the other sources in order: PDF → photos → screenshot → a
   stronger model.
3. **Veg-label audit** — before results are saved, a stronger model re-checks
   *only* the dishes labelled vegan/vegetarian/unknown for hidden animal
   ingredients: fish sauce, gelatin, meat stock, anchovy. This is the answer
   people actually trust the product for, so it gets the more expensive model.

Every parsed restaurant is cached in Supabase and flagged stale after 30 days.

### Models and cost

- **Haiku 4.5** does discovery labelling and extraction — reading dishes off a
  menu is mechanical work.
- **Sonnet 4.6** handles escalation when extraction fails validation, and the
  veg-label audit. Opus is not used.
- Typical cost is **3–7¢ per restaurant**, rising to 15–25¢ for photo menus that
  need the whole ladder. **Failures are the most expensive path** — a site with
  no readable menu still burns every rung.
- Every call, success or failure, writes to the append-only `ai_usage_log`
  table, which survives database wipes. `db/monitoring.sql` has ready-made
  spend reports.

### The veggie count

One number, everywhere. `menuTallies()` in `lib/menu-insights.ts` is the single
walk of a menu; the guide card, the restaurant page, the filter tabs and the
share message all derive from it. `lib/dish-role.ts` decides what counts — it is
pure, deterministic string logic with no AI, so a side of chips or a dessert
doesn't inflate the number a vegetarian is shown. The user-facing explanation
lives in `COUNTING_METHOD_BODY` in `lib/site-copy.ts`; if the methodology
changes, that copy changes in the same commit.

---

## Project layout

```
app/
  api/parse/     discover (scrape + find menus) and analyze (resumable
                 extraction, sized to fit Vercel's 60s function cap)
  [city]/        every city guide — one dynamic route serves them all
  restaurant/    results pages
  admin/         review, evaluation, feedback and guide management
lib/
  scraper.ts       web scraping
  reader.ts        JS-rendering page reader (Jina / Firecrawl)
  menu-discovery   finds candidate menus
  menu-extract     extraction retry ladder + multi-menu merge
  ai.ts            Claude API: tiered models, single spend choke point
  url-guard.ts     SSRF protection for every outbound fetch
  spend-guard.ts   global daily AI spend ceiling
  rate-limit.ts    per-IP budgets
  dish-role.ts     what counts as a dish a vegetarian would order
db/schema.sql    full schema, RLS-locked
scripts/         seeding, QA, spend backup, safe wipe
tests/           unit tests over recorded fixtures with the AI mocked
```

**Adding a city:** create the guide in `/admin/guides` and seed restaurants
against its slug. `app/[city]/page.tsx` renders every city — never add a
per-city route, because a static route silently shadows the dynamic one.

**Adding a dietary filter:** add an entry to `DIETARY_FILTERS` in
[`lib/dietary-config.ts`](lib/dietary-config.ts). No other changes needed.

---

## Testing

Two tiers, because one of them costs real money.

- **Free, on every push:** lint, typecheck, build and unit tests over recorded
  website snapshots with the AI mocked — including prompt-regression guards that
  fail the build if load-bearing prompt rules are weakened. `npm test`.
- **Live QA (real sites, real AI, real money):** `npm run test:pipeline`.
  `--smoke` ≈ $0.26 (7 sites) · the full core set ≈ $3.00 (20 sites) ·
  `--extended` more again. Run it deliberately, not habitually, and re-measure
  the cost from `ai_usage_log` rather than trusting these figures. **Never wire
  live-AI runs into per-push CI.**

---

## Security

- **Every table has RLS enabled with zero policies, on purpose.** The browser
  never talks to Supabase; all access is server-side through the service role,
  which bypasses RLS. RLS-on-with-no-policies therefore means "deny everything"
  to the public `anon` key. Adding a policy would *open* access, not restrict
  it. New tables and functions must also have their grants revoked from
  `PUBLIC` — Postgres grants function `EXECUTE` to `PUBLIC` by default.
- **User-supplied URLs are treated as hostile.** `lib/url-guard.ts` validates
  scheme, port and resolved IP before every outbound fetch, and re-validates on
  each redirect hop, so the scraper cannot be pointed at cloud metadata or
  private network ranges.
- **AI spend is bounded in two places**: a per-IP hourly budget and a global
  daily ceiling (`lib/spend-guard.ts`). Both fail closed.
- Secrets stay server-side. `.env.local` is untracked and no key is exposed to
  the client bundle.

## Privacy

- No accounts. A random anonymous ID cookie is set on arrival to count visits;
  it is never linked to an identity or used for advertising.
- Product analytics (PostHog) run only after you accept analytics cookies.
  Before that, page views are counted in memory with no profile created.
- Rate limiting stores a **salted, shortened one-way hash** of the IP address,
  never the address itself. This is pseudonymisation, not anonymisation.
- Operational records — whether an analysis succeeded, how long it took, what it
  cost — are kept regardless of consent, because they are how the service is
  run rather than a way of profiling anyone.

## Deployment

Vercel, free Hobby plan. Long analyses are split into several short resumable
requests so they fit the 60-second function cap: the `analyze` endpoint persists
progress and asks the client to call back.

## Credits

Flag glyphs are [Twemoji](https://github.com/jdecked/twemoji) (CC-BY 4.0),
bundled via `country-flag-emoji-polyfill` (MIT) because Windows' system emoji
font omits country flags.
