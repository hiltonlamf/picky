# Picky 🥦

**Find your food, your way.**

Picky is a web app that helps vegetarians and vegans quickly find what they can eat at any restaurant — before they even leave home. Paste any restaurant link and Picky reads the menu, classifies every dish as vegan/vegetarian/neither, and returns a clean, organised summary.

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Then fill in the values in `.env.local`:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `GOOGLE_PLACES_API_KEY` | Google Cloud → Places API (New); server-side restaurant-name lookup |

### 3. Set up the database

1. Create a [Supabase](https://supabase.com) project (choose Frankfurt region for EU/GDPR)
2. Go to **SQL Editor** → **New Query**
3. Paste the contents of [`db/schema.sql`](db/schema.sql) and run it

### 4. Seed the Dublin city guide (optional)

```bash
npx tsx scripts/seed-dublin.ts
```

This inserts the 10 featured Dublin restaurants. Each will be parsed automatically on first visit.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Restaurant name search checks Picky's Dublin database before Google. For live
fallback results, enable Places API (New), restrict the key to that API, set a
Google Cloud usage quota/budget alert, and add `GOOGLE_PLACES_API_KEY`. Without
it, database name search and direct website-link entry continue to work.

---

## Project structure

```
picky/
├── app/
│   ├── api/
│   │   ├── parse/          # SSE endpoints: discover (scrape + find menus),
│   │   │                   #   analyze (resumable extraction, fits Vercel 60s cap)
│   │   ├── restaurants/    # Fetch restaurant results
│   │   └── report/         # Report a dish
│   ├── restaurant/[id]/    # Results page (per-menu dropdown for multi-menu sites)
│   ├── dublin/             # Dublin city guide
│   └── page.tsx            # Home page
├── components/             # UI components
├── lib/
│   ├── dietary-config.ts   # Dietary filter config (extensible)
│   ├── scraper.ts          # Web scraping
│   ├── reader.ts           # JS-rendering page reader (Jina free tier / Firecrawl)
│   ├── menu-discovery.ts   # Finds candidate menus (links, PDFs, images, subpages)
│   ├── menu-extract.ts     # Extraction retry ladder + multi-menu merge
│   ├── ai.ts               # Claude API: tiered models + veg-label audit
│   ├── db.ts               # Supabase operations + append-only spend log
│   └── rate-limit.ts       # IP-based rate limiting
├── types/                  # TypeScript types
├── db/
│   ├── schema.sql          # Supabase schema (incl. ai_usage_log)
│   ├── monitoring.sql      # Ready-made spend/usage report queries
│   └── spend-backups/      # CSV spend exports (written before any wipe)
├── tests/                  # Free unit tests: recorded fixtures, mocked LLM,
│                           #   prompt-regression guards
└── scripts/
    ├── seed-dublin.ts        # Dublin restaurant seeder
    ├── run-pipeline-tests.ts # LIVE QA suite (real sites + real AI = real $)
    ├── record-fixture.ts     # Snapshot a site for the free unit tests
    ├── backup-spend.ts       # Export spend history to CSV
    └── wipe-menus.ts         # Safe DB wipe (backs up spend first, refuses otherwise)
```

## Architecture notes

### Menu pipeline (discover → extract → audit)
1. **Discovery** — scrape the site, find candidate menus (page text, PDFs,
   photos, subpages). A cheap Haiku call labels them ("Lunch", "Dinner"),
   drops wine lists, and de-duplicates same-menu-different-format copies.
   Multi-menu sites show a picker; single-menu sites go straight through.
2. **Extraction** — one AI call reads the chosen menu and classifies every
   dish (vegan/vegetarian/neither/unknown). If the result fails validation
   (<7 food items, or header-like junk), a retry ladder tries the other
   sources in order: PDF → photos → full-page screenshot → strongest model.
3. **Veg-label audit** — before results are saved, a stronger model
   re-checks ONLY the dishes labeled vegan/vegetarian/unknown for hidden
   animal ingredients (fish sauce, gelatin, meat stock...). Cheap (text-only,
   ~1¢) and protects the answer users actually trust us for.

### Model tiering & cost (the #1 engineering constraint)
- **Haiku 4.5** (cheapest) does discovery labeling AND extraction — reading
  dishes off a menu is mechanical OCR-style work.
- **Sonnet 4.6** is the escalation when extraction fails validation, and
  runs the veg-label audit. Opus is not used.
- Typical cost per restaurant: ~3–5¢ (clean text menu) to ~15–25¢ (photo
  boards needing the full retry ladder). **Failures cost the most** — a
  site with no readable menu still burns the whole ladder.
- Every analysis (success or failure) writes cost to the append-only
  `ai_usage_log` table, which survives database wipes. `db/monitoring.sql`
  has ready-made spend reports.

### Caching
Every parsed restaurant is stored in Supabase. Repeat visits return cached results instantly. Data is flagged as stale after 30 days.

## Testing (two tiers — one free, one costs money)

- **Free, on every push (CI):** lint, typecheck, build, and unit tests over
  recorded website snapshots with the AI mocked — including prompt-regression
  guards that fail the build if load-bearing prompt rules (never invent
  dishes, exclude drinks, audit veg labels) are weakened. Run locally:
  `npm test`.
- **Live QA (costs real money):** `npm run test:pipeline` runs the real
  pipeline against real restaurant sites with real AI calls.
  `--smoke` = 3 sites (pennies) · full = 14 sites (~$0.75) ·
  `--extended` = 27 sites (~$1.30+). It runs automatically once per merge
  to main (non-blocking signal, results in the Actions summary) — add
  `[skip live-qa]` to the merge commit/PR title if the branch was already
  validated with a local live run. Never wire it to run per-push.

### Adding new dietary filters
Edit [`lib/dietary-config.ts`](lib/dietary-config.ts) — add a new entry to `DIETARY_FILTERS`. No other code changes needed.

### Adding new cities
Add a page at `app/[city]/page.tsx` (duplicate `app/dublin/page.tsx`). Seed restaurants with the seeder script pointing at the new city slug.

## Deployment (Vercel)

1. Push to GitHub
2. Import repo in [vercel.com](https://vercel.com)
3. Add environment variables in the Vercel dashboard
4. Deploy

> **Note:** The app is designed to fit the free Vercel Hobby plan's 60-second
> function cap: long analyses run as several short resumable requests (the
> `analyze` endpoint persists progress and asks the client to call back).

## GDPR

- Rate limiting uses a **hashed** IP (SHA-256, not reversible)
- No user accounts or tracking cookies
- Cookie consent banner included
- Supabase can be hosted in **Frankfurt** for EU data residency
