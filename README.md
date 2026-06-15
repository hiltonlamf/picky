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

### 3. Set up the database

1. Create a [Supabase](https://supabase.com) project (choose Frankfurt region for EU/GDPR)
2. Go to **SQL Editor** → **New Query**
3. Paste the contents of [`db/schema.sql`](db/schema.sql) and run it

### 4. Seed the Dublin city guide (optional)

```bash
npx ts-node scripts/seed-dublin.ts
```

This inserts the 10 featured Dublin restaurants. Each will be parsed automatically on first visit.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Project structure

```
picky/
├── app/
│   ├── api/
│   │   ├── parse/          # SSE streaming parse endpoint
│   │   ├── restaurants/    # Fetch restaurant results
│   │   └── report/         # Report a dish
│   ├── restaurant/[id]/    # Results page
│   ├── dublin/             # Dublin city guide
│   └── page.tsx            # Home page
├── components/             # UI components
├── lib/
│   ├── dietary-config.ts   # Dietary filter config (extensible)
│   ├── scraper.ts          # Web scraping
│   ├── ai.ts               # Claude API (tiered model usage)
│   ├── db.ts               # Supabase operations
│   └── rate-limit.ts       # IP-based rate limiting
├── types/                  # TypeScript types
├── db/
│   └── schema.sql          # Supabase schema
└── scripts/
    └── seed-dublin.ts      # Dublin restaurant seeder
```

## Architecture notes

### Classification pipeline
1. **Keyword matching** (free): Explicit markers like `(v)`, `(ve)`, `vegan`
2. **Claude Haiku** (cheap): English menus, straightforward dishes
3. **Claude Sonnet** (capable): Non-English or complex/ambiguous menus

### Caching
Every parsed restaurant is stored in Supabase. Repeat visits return cached results instantly. Data is flagged as stale after 30 days.

### Adding new dietary filters
Edit [`lib/dietary-config.ts`](lib/dietary-config.ts) — add a new entry to `DIETARY_FILTERS`. No other code changes needed.

### Adding new cities
Add a page at `app/[city]/page.tsx` (duplicate `app/dublin/page.tsx`). Seed restaurants with the seeder script pointing at the new city slug.

## Deployment (Vercel)

1. Push to GitHub
2. Import repo in [vercel.com](https://vercel.com)
3. Add environment variables in the Vercel dashboard
4. Deploy

> **Note:** The parse API route uses `maxDuration = 60`. The free Vercel Hobby plan has a 10-second limit — upgrade to Pro for reliable parsing of large menus.

## GDPR

- Rate limiting uses a **hashed** IP (SHA-256, not reversible)
- No user accounts or tracking cookies
- Cookie consent banner included
- Supabase can be hosted in **Frankfurt** for EU data residency
