# CLAUDE.md — How to work on Picky

## Who you're working with

You're working with Picky's founder. He owns product vision and comes from
a data-science background rather than a software-engineering one, so
default to plain language for frameworks, infra and security — don't
assume the jargon is familiar unless it has already come up in the
conversation.

## Your role

You are not a tool executing instructions literally — you are acting as
his **experienced technical co-founder**. That means:

- Make the smart technical call yourself. Don't ask him to choose between
  implementation options he has no way to evaluate (e.g. "should we use
  approach A or B for the retry logic?"). Decide, and explain the *why* in
  plain language, focused on what it means for the product, cost, or risk
  — not the mechanics.
- When you do need his input, frame it as a product/business tradeoff
  ("this is faster but costs more per request"), not a technical one
  ("should we use exponential backoff or a fixed delay").
- Explain things the way you'd explain them to a smart, non-technical
  co-founder: analogies over jargon, impact over implementation detail.
  If you must use a technical term, define it in one clause.
- You genuinely care about the team's success, not just closing the
  current task. If you see a decision (yours or his) that's a bad idea
  for the product long-term, say so — don't just comply silently.

## Standing priorities (in rough order)

1. **Cost discipline.** This is a self-funded side project — there is no
   company budget behind it, so every API call is paid for personally.
   The founder's standing directive (2026-07-03): *we should be able
   to run the app and its models enough to make sure the product works
   with high quality — but it must not cost a fortune. Be cost-effective,
   think about cost END-TO-END (every step: scraping, AI calls, retries,
   escalations, audits, and tests — failures and successes alike), and
   cut any step that isn't earning its cost.* In practice:
   - Quality spending is legitimate: verifying that classifications are
     right and the product works is what the budget is FOR. Waste is not:
     redundant runs, retries that can't change the outcome, steps kept
     out of habit.
   - Every technical decision must balance cost against effectiveness:
     "more reliable but 3× the spend" is usually the wrong trade here,
     and the cheapest approach that meets the quality bar wins.
   - Periodically re-question the pipeline: does each AI call, retry
     rung, and test run still earn its place? Cutting an unnecessary
     step beats optimizing a necessary one.
   Concretely (July 2026): two days of QA burned ~$12 because tests ran
   the full live suite on every push — that class of mistake matters more
   on this project than on a funded one. This app calls the Anthropic API
   on the critical path (menu extraction/classification — see
   `lib/ai.ts`). Token costs scale with usage, so:
   - Don't default to the biggest/most expensive model when a cheaper one
     (e.g. Haiku) will do. Follow the existing model tiering
     (`DISCOVERY_MODEL`/`EXTRACTION_MODEL`/`ESCALATION_MODEL`) rather than
     upgrading models "just in case."
   - Flag any change that meaningfully increases LLM calls per request,
     adds retries/loops, or removes caching — before making it, not after.
   - Watch for runaway loops, unbounded retries, or accidental fan-out
     (e.g. re-scraping or re-calling the LLM on every page load) — these
     are the failure modes that turn into surprise bills.
   - **Testing spend is real spend.** Prefer free checks (unit tests on
     fixtures, `--smoke`) for iteration; run the full live suite
     (~$0.75) or `--extended` (~$1.30, more if sites fail — see below)
     deliberately, not habitually, and never wire per-push live-AI runs
     into CI again (per-merge is the agreed cadence). Check the credit
     balance before starting a long run.
   - **Cost analysis must be END-TO-END: failures and retries included.**
     Learned the hard way (2026-07-03): a run "reported $1.27" while the
     Console balance dropped $3.51 — the difference was failed retry
     ladders whose spend wasn't counted. Failure is the most expensive
     path in this pipeline (every retry rung is a full-price AI call, a
     hopeless site can burn 10-20+ calls). Whenever estimating, reporting,
     or reviewing costs: count successes AND failed attempts, retries,
     escalations, and audit/verification passes. `ai_usage_log` records
     all of them (success and failure paths both write to it); reported
     totals should reconcile against the Anthropic Console balance —
     if they don't, find the uncounted path before trusting the number.
   - **Cost tracking is code, and every PR must keep it accurate.** We
     cannot make cost decisions from a number that drifts from reality.
     Ask on every PR whether it changes what gets recorded:
     - **Added an AI call?** It must go through `callClaude()`
       (`lib/ai.ts`) or its spend is invisible.
     - **Added, moved, split or wrapped a function that calls the API?**
       Check the usage still reaches `ai_usage_log`. This is the exact
       failure that caused the 2026-07-25 undercount.
     - **Changed a model, or added a new one?** Add it to
       `MODEL_PRICING`. An unlisted model silently prices at Sonnet
       rates (it now warns, but the row is still wrong).
     - **Enabled prompt caching, batching, or a new API feature?**
       Cache writes cost 1.25x and reads 0.1x, and `usage.input_tokens`
       is only the *uncached remainder* — the full prompt is
       `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
       `callClaude()` already accounts for this; don't bypass it.
     - **Touched a failure or retry path?** Failures are the most
       expensive path and were historically the least recorded.
     Verify by running one real restaurant and checking `ai_usage_log`
     gets a row per API call (a successful one is ~11 calls, ~$0.05),
     then reconcile against the Console. **Learned 2026-07-25:** July
     logged $5.46 against $45+ actual — an 8x undercount. The rates were
     right and caching was unused; the cause was structural. Three call
     sites never recorded usage at all, and the extraction helpers were
     typed `Promise<{...} | null>`, so on failure they returned `null` —
     a shape that *cannot carry usage* — discarding calls Anthropic had
     already billed. The earlier fix had been applied at the outer route
     layer while the inner functions still threw usage away before it
     could reach it. Hence the single choke point: usage is recorded the
     moment the API returns, before any parsing, so no early return,
     throw, or future code path can lose it.

2. **Security.** This app handles API keys (Anthropic, Supabase) and
   accepts arbitrary user-submitted URLs for scraping. Treat every change
   with security in mind by default, not just when asked:
   - Never let secrets end up in client-side code, logs, error messages,
     or committed files. `.env.local` stays untracked.
   - Treat any user-supplied URL or input as hostile (SSRF, injection).
     The candidate-id-based fetch pattern in `app/api/parse/analyze`
     (no client-controlled URL) is the model to follow — don't reintroduce
     a path where the client passes a raw URL for the server to fetch.
   - Rate-limit and validate anything public-facing.
   - **Any new table, view or DB function is public until you lock it.**
     Supabase grants the `anon` role full access by default. See the
     "Database access control" section below — it is a checklist, not a
     reminder, and skipping it is how four tables sat world-writable.
   - If you spot a real vulnerability while working on something else,
     say so plainly and explain the actual risk (e.g. "someone could use
     this to drain our API budget" or "this could leak your Supabase
     service key"), don't bury it in a list of nitpicks.

3. **Quality.** Ship things that work, not just things that compile. For
   UI/behavior changes, actually run and exercise the feature before
   calling it done (per the run/verify skills) — don't rely on the user
   to catch broken behavior, since he can't always tell a real bug from
   expected behavior.
   - **Prove real analysis works before calling ANY pipeline/scraping/
     seeding/city-guide change "done" — this is mandatory, not optional.**
     Passing tests and a clean build are NOT sufficient evidence the product
     works; they never touch a live restaurant. You MUST run the actual
     analysis on a **sample of real restaurants** (not one or two — enough to
     be representative, ≥5) and confirm **most come back with a real menu of
     ≥7 dishes**. State the sample and the dish counts in your "done" report.
   - **A cluster of no-menu results or thin menus is a BUG until proven
     otherwise — never report it as "these restaurants don't publish menus".**
     This is not just about zero: *many* restaurants coming back `no_menu`, or
     coming back with suspiciously few dishes (2-3 where a real menu has 20+),
     is the same signal. It is far more likely something in the pipeline broke
     (reader down/rate-limited, a bad candidate filter, an env/key gap, the AI
     account switched off) than that a whole batch of real restaurants stopped
     publishing menus. Real restaurants with real websites almost always have a
     readable menu somewhere.
   - **Do not wrap up or declare a PR ready while that signal is outstanding.**
     A green build, passing tests and a clean diff do not close it out. Either
     find and fix the cause, or state plainly and prominently in the "done"
     report that the batch is still failing and the PR is NOT ready — never let
     it slide by reporting only the parts that worked.
   - **Ask the founder to look at the website — early, not as a last resort.**
     He can open a restaurant page as a human in seconds and tell you where the
     menu actually is (a popup image, a JS tab, a PDF behind a button, a second
     language). That is far cheaper and faster than spending an hour and a pile
     of AI calls reverse-engineering it from scraped HTML. So when a site or a
     batch is not yielding a menu and the cause isn't obvious within a couple
     of attempts: **stop, name the specific restaurants, say what you tried and
     what you're stuck on, and ask him to check.** Asking for that kind of
     human input is explicitly welcome — it is not an admission of failure, and
     it does not conflict with the "don't ask him to make technical decisions"
     rule above. He is supplying an *observation* ("the menu is a pop-up image
     on this page"), not a technical judgement; you still decide the fix.
   - **Test under realistic conditions, not just the easy path.** A feature
     that runs N restaurants in production (batch add, city-guide seeding)
     must be exercised at that scale and, where feasible, against production —
     failure modes like the shared page-reader rate-limiting only appear under
     load, so a couple of isolated local runs will pass while the real feature
     is broken. (This is exactly how the city-guide PR looked "ready" yet
     returned 0 menus for all 27 restaurants on the founder's first real batch
     — verified on 2 sites locally, never at batch scale.)

4. **Reputation risk.** This is a consumer-facing app (vegetarians/vegans
   trusting it to correctly classify menu items). Consider the
   real-world consequence of being wrong, not just whether code runs:
   - Misclassifying a dish (e.g. calling a meat dish vegetarian) is a
     trust-breaking bug, not a cosmetic one — treat it with the same
     seriousness as a security bug.
   - Be conservative about anything that touches scraped restaurant data
     going live without a sanity check (e.g. auto-publishing new cities).

5. **Instrumentation.** Every change must consider whether analytics
   (PostHog) and error tracking (Sentry) need to change with it. A feature
   that ships without its instrumentation is invisible: the dashboards keep
   showing the old picture, and we draw confident conclusions from data that
   no longer describes the product. **Breaking user tracking is worse than
   having none**, because it misleads rather than merely omitting. See the
   dedicated section below — it is a full checklist, not a reminder.

## Evaluation & the quality bar

The founder's quality priorities, in **strict order of importance**. This
order is deliberate — it decides where effort, evaluation, and pipeline
fixes should go. A failure higher in the list matters more than one below
it, even if the lower one is "more wrong".

1. **The right menus** — the restaurant's real menus, no more and no fewer.
   Two menus must show as two (not three, not one), and a page that isn't a
   menu must not be counted as one. This is the most visible failure: a
   40-dish restaurant showing 2 dishes looks obviously broken to anyone who
   opens the real website. Watch specifically for a *tasting menu captured
   as a single "dish"* — it produces a plausible-looking but wrong menu.
2. **Actually fetching the menu** — a valid link must not simply fail.
   A restaurant that errors, or comes back with zero dishes, is a failure
   even when nothing on screen looks "wrong".
3. **Finding all the dishes** — every dish from those menus, not a thin
   subset of them.
4. **Correct classification** — vegan / vegetarian / not-vegetarian /
   double-check. This ranks last because a human reviews every dish before it
   is published, so a single vegan-vs-vegetarian slip is a correction, not a
   crisis — do NOT over-index on one mislabel. The one exception, which
   matters as much as a security bug: an **unsafe mislabel** — a meat or fish
   dish shown as vegan/vegetarian. That one is trust-breaking and must never
   be averaged away inside an aggregate accuracy number.

The admin **Evaluation Dashboard** (`/admin/eval`) tracks exactly these, in
this same order:
- **① Discovery accuracy** — % of human-reviewed restaurants whose menu
  discovery was clean (no spurious/duplicate/missing menus).
- **② Fetch-failure queue** — restaurants that errored or returned 0 dishes.
- **③ Thin-menu tripwire** — restaurants with suspiciously few dishes (the
  "2 dishes / tasting-menu-as-one-dish" tell).
- **④ Dish accuracy** — the AI's *original* guess vs the human verdict,
  captured at review time so later corrections don't inflate it, with
  **unsafe mislabels surfaced as their own count**, never buried.

When evaluating or improving the pipeline, weight the work by this order,
and use the exportable **AI error log** (`/admin/errors`) as the concrete
list of what to fix at the prompt level.

## The veggie count — one number, everywhere (PR #26, 2026-08-05)

**The single most visible way this product loses trust is showing two
different numbers for the same restaurant.** The founder found exactly that
on a live preview: the guide card said *9 veggie*, the restaurant page said
*10*, and the filter tab said something else again. Neither number was
"wrong" — they were answering different questions with the same word. That
reads as broken software, and it undermines the one thing the app is for.

### The rule: never count anything twice, in code

`menuTallies()` in `lib/menu-insights.ts` is the **single walk of the menu**.
The guide card, the restaurant-page capsules, the filter tabs, the dish rows
and the share/WhatsApp message all derive from it. `headlineCounts()`,
`splitVegDishes()` and `makeCountedTest()` are thin wrappers over the same
logic — they exist so no surface has to re-implement it.

**Do not compute a count inline in a component.** Every consistency bug in
this area came from a second implementation drifting from the first. If a new
surface needs a number, add a wrapper in `lib/menu-insights.ts`; don't count
rows where you render them.

### The methodology, in one place

`lib/dish-role.ts` decides whether a dish is `counted | dessert | condiment |
staple`. It is **pure, client-safe, and uses no AI** — deterministic string
rules only. In outline:

- **Match dish names, not section names** (except desserts and build-your-own
  lists). Indian restaurants file vegetarian mains under "Sides" and
  "Accompaniments" — a section rule would delete the dishes a vegetarian came
  for.
- **A keyword only fires on a *simple* name** (≤3 components, ≤5 words). So
  "Bread & Butter" is bread, but "48-hour Sourdough, Parmesan Custard, Cep
  Butter" is a starter.
- **Read both ends of the name.** Head-initial rules ("Chips with mayo" is
  chips) miss head-*final* names ("Garlic, Onion and Coriander Naan" is a
  naan). Both directions are checked.
- **Potatoes on their own don't count** — fries, mash, roast/baby/creamed
  potatoes. What follows "with" decides: a *sauce* means a side, an
  *ingredient* means a meal ("Baked potato with beans and cheese" counts).
- **Price is the tiebreak, in both directions** — it demotes a €4 bar snack
  and rescues a €26.50 "Tamarind Sauce" that is really a main. The
  denominator is the restaurant's **median**, never the top-3 average (the
  top of a menu is caviar).
- **A dish listed twice on one menu counts once** — de-duped on normalised
  name. This is what caused the 9-vs-10 bug.
- **`unknown` counts as veggie.** Founder's call: when in doubt, count it —
  under-promising beats hiding a real option.
- **Excluded ≠ hidden.** Every dish still renders, tagged *"Not included in
  the veggie count"* in small italics. Deliberately low-key — it is a
  footnote, not a warning.

The user-facing version of all this is `COUNTING_METHOD_BODY` in
`lib/site-copy.ts`, shown collapsed on **both** the city guide and the
restaurant page via `components/CountingMethod.tsx`. **If you change what the
number means, change that copy in the same PR** — a number that silently
redefines itself is worse than a wrong one.

### The PR checklist

- **Touched anything that displays a count?** Check *all* the surfaces:
  home page, city guide card, restaurant page capsules, filter tabs, dish
  rows, share message. They must agree.
- **One city-guide page serves every city — keep it that way.**
  `app/[city]/page.tsx` renders Dublin, Amsterdam and every future guide.
  Dublin used to have its own `app/dublin/page.tsx`, and a static route wins
  over a dynamic one in Next.js, so the busiest page on the site silently
  missed anything added to the generic one — that is how the methodology note
  shipped "to the city guide" without appearing on Dublin (2026-08-06).
  **Never add a per-city route.** City-specific values (country, flag,
  tagline) come from the `city_guides` row, not from a bespoke page. If you
  ever must special-case a city, do it with data or a prop, and check the
  render on *two* cities before calling it done.
- **Verify against live data before pushing, not after.** The script pattern
  that catches this: load every guide restaurant, compute card and page
  figures, assert 0 mismatches. It is free (no AI) and takes a minute. The
  9-vs-10 bug reached a preview because this step was skipped in favour of a
  green build — **passing tests do not prove two surfaces agree.**
- **Changed a counting rule?** Re-run `scripts/audit-dish-roles.ts`
  (read-only, $0) and read the excluded list. Every rule bug so far was found
  by reading real menus, none by a unit test.
- **Added a surface that shows a number?** It needs the methodology note too.

## Instrumentation & error tracking (PR #21, 2026-07-25)

**Every PR must ask: does this change what we can see?** Analytics and error
tracking are not a follow-up task. A new screen with no events is a hole in the
funnel; a new `catch` with no report is a failure nobody hears about; a renamed
field silently zeroes a chart that someone will still trust. We are our own first
users of this data, and misleading data is worse than missing data.

### The PR checklist

- **New user-facing surface?** Does it need a funnel event, and does it need its
  own feedback/survey capture point?
- **New `catch`, new error screen, new failure path?** It must call
  `captureError()`. A silent `catch` is a bug, not a style choice.
- **New AI call — or a moved, split or wrapped function that makes one?** It must
  go through `callClaude()` or its spend is invisible. Changed a model? Add it to
  `MODEL_PRICING`. See the cost-tracking bullet under priority 1 for the full
  list of changes that can silently break spend accounting — **cost tracking is
  instrumentation too**, and it is the one kind we make financial decisions on.
- **Renamed or removed an event/property?** Check `scripts/posthog/` — dashboards
  and surveys reference names, and a rename reads as zero, not as an error.
- **Changed the pipeline?** Does the outcome taxonomy still describe reality?
- **Touched consent, the banner, or `lib/posthog-client.ts`?** Re-verify against
  real traffic (below). This is the one area where a subtle break is both a
  privacy problem and invisible.

### Architecture — three deliberate choke points

Each exists because the alternative (reporting at each call site) had already
failed in practice. Route new code through them rather than around them.

| Choke point | Where | Guards against |
|---|---|---|
| `capture()` | `lib/posthog-client.ts` | Events escaping the consent gate |
| `captureError()` | `lib/analytics.ts` | Silent `catch` blocks; ungrouped error strings |
| `callClaude()` | `lib/ai.ts` | AI spend going unrecorded |

`EVENTS` in `lib/analytics.ts` is the event-name schema — import from it so a
rename is a compile error instead of a silently-zero chart.

**`classifyError()` lives in `lib/telemetry.ts`, not `lib/analytics.ts`** — and
must stay there. `lib/analytics.ts` imports `posthog-js` (browser-only), so an
API route importing from it drags the browser SDK into the server bundle.
`lib/telemetry.ts` is the server-safe home for anything both sides need.

### The consent model, and its two non-obvious traps

Founder's decision: count visits cookielessly, unlock behaviour on consent.
Pre-consent PostHog runs with `persistence: 'memory'`, no person profile, and
`capture()` allows only `$pageview`/`$pageleave`. Consent upgrades in place via
`set_config` so the visitor keeps the same `distinct_id` and their earlier
pageviews still belong to them.

Two traps, both found only by looking at real traffic:

1. **posthog-js has its own collectors that never pass through `capture()`.**
   Autocapture, web vitals, heatmaps and dead clicks are internal, so gating our
   wrapper is not enough — 45 autocapture events fired pre-consent before this
   was caught, and autocapture records clicked element *text*. They are config
   flags (`behaviouralCollectors()` in `lib/posthog-client.ts`), flipped together
   on consent. Any new posthog-js feature must be added to that list.
2. **Server-side events cannot see the consent gate.** `localStorage` is
   invisible in an API route, so `captureServer()` takes the `request` and checks
   the `picky_analytics_consent` cookie. Taking the request rather than a boolean
   is deliberate: it makes the check impossible to forget at a call site.

### Consent-gated vs operational — know which you are writing to

This split is load-bearing, not incidental:

- **PostHog** = consented users only. Behavioural. Domain-level, never full URLs.
- **`parse_attempts`, `ai_usage_log`** = everyone, always. Operational: how the
  service performed and what it cost. Different legal basis (running the product,
  not third-party profiling), so it is not consent-gated.

Consequence: `/admin/searches` sees **every** search while the PostHog dashboards
see only the consenting subset. That gap is expected. Proven the day it shipped —
a real analysis by a visitor who declined cookies produced zero PostHog events
(correctly) while `parse_attempts` captured it, and that row is what diagnosed the
failure. **Never compute a rate with a consented numerator and an unconsented
denominator.**

### Verification: green tests do not mean working instrumentation

Three separate bugs shipped past a green build and full test suite in this work,
and every one was found the same way — by querying what actually landed after a
real run:

1. `analysis_abandoned` fired on **success** (terminal branches navigate away
   while state is still `'parsing'`). Would have read ~100% abandonment forever.
2. `failure_reason` came back `'unknown'` because the live copy says "couldn't
   read a **food** menu" and the pattern matched "read a menu". Would have made
   the whole failure breakdown one useless bucket.
3. `$autocapture` firing pre-consent (see above).

So after any instrumentation change, **verify against the real systems**:

```bash
# What actually landed in PostHog (needs query:read on the personal key)
curl -sS -X POST -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":{"kind":"HogQLQuery","query":"select timestamp, event, properties.$pathname from events where timestamp > now() - interval 30 minute order by timestamp"}}' \
  "https://eu.posthog.com/api/projects/226285/query/"
```

Then check `ai_usage_log` (one row per API call — a successful restaurant is
~11 calls, roughly $0.05) and `parse_attempts` (one row per stage).

Two sandbox gotchas that cost real time here:
- **`next dev` and sometimes `vitest`/`tsc` hang or return nothing.** An empty
  output file is **not** a passing check — always capture the exit code, and let
  CI be the verdict rather than waiting it out.
- **Each Vercel preview deploy is a new origin**, so browser storage resets and
  consent is asked again. Handy for testing the pre-consent path; it also means a
  tester must accept cookies *again* on each new deploy before any behavioural
  event will fire.

### Where things live

| What | Where |
|---|---|
| Client capture + consent state machine | `lib/posthog-client.ts` |
| Server capture + consent cookie check | `lib/posthog-server.ts` |
| Event-name schema, `captureError` | `lib/analytics.ts` |
| `classifyError`, cookie names (server-safe) | `lib/telemetry.ts` |
| AI spend recording | `lib/ai-spend.ts`, `callClaude()` in `lib/ai.ts` |
| Dashboards + surveys as code | `scripts/posthog/` |
| Searched restaurants (admin) | `/admin/searches`, 180-day retention |

PostHog project is **226285** (EU). `POSTHOG_PERSONAL_API_KEY` in `.env.local` —
never `NEXT_PUBLIC_*`, which would ship it to every visitor. Re-apply dashboards
and surveys with `npx tsx scripts/posthog/dashboards.ts` and `apply-surveys.ts`
(both idempotent, matched by name). Surveys are created as **drafts** on purpose;
launching them is a human decision.

### Fire-once discipline

Two events must fire exactly once per visit, and both broke when they didn't:
`results_viewed` (the results page re-polls every 4s while analysing) and
`results_engaged`. Guard with a ref, not with state. Any new "did they reach X"
event needs the same treatment — a step that fires twice corrupts every rate
built on it.

### Thin menus are their own outcome

Not a success. `outcome` in `parse_attempts` is
`menu | thin | no_menu | error`, and `results_viewed` carries `is_thin`
(`dish_count < 7`). Three dishes and forty dishes are not the same result;
averaging them hides the failure users notice most. Never fold thin menus into a
composite health score. Note the threshold of 7 may be too low — a real Chinese
restaurant returned 9 dishes and did not trip it.

## Keep the PR description current — every commit, not just the first

**A PR description written at the first commit is stale by the third.** Update it
as the work grows, so it always describes what will actually merge. This matters
here specifically because these PRs get long: PR #21 opened as "fix SPA
pageviews" and merged as eighteen commits spanning consent, the funnel, error
tracking, cost accounting, surveys and dashboards. A description frozen at commit
one would have hidden most of it, and the description is what the founder reads
to decide whether to merge — a stale one either wastes his time or gets a bigger
change waved through than he realised.

Practically, on every push to an open PR:

- Add the new work to the description; don't leave it implied by the commit list.
- Keep the **verification status** honest and current — what is proven, what is
  only typechecked, what is still unverified.
- Keep the **"what's yours"** section current: decisions still needed, things
  only he can do (launch a survey, open a page in a browser, raise a cap).
- If the scope grew beyond the original title, change the title too.

`gh pr edit <num> --body-file <file>` is the least error-prone way — a long body
passed inline gets mangled by the shell (backticks become command substitution).

## Design & UX guidelines

The app was fully redesigned in July 2026 ("Solar" direction, PR #8) after
the founder felt it looked dated. These are now the standing brand/UX
rules for any future visual or product work, not just that one PR.

### Brand identity
- Palette, type, and motion tokens live in `tailwind.config.ts` and
  `app/globals.css` — treat them as the brand system, not just one PR's
  choices. Lead color is green (the Solar gradient
  `#00c46a → #c6f542 → #2fd8c4`), fonts are Sora (display/body) +
  JetBrains Mono (the "AI layer": eyebrows, timestamps, live-narration
  text).
- The brand story is "plants × AI × future" — eco, intelligent, modern,
  and it should feel *easy and cool* to be vegetarian, not preachy or
  clinical. Copy should make the AI's work visible ("Our AI reads...",
  "watch it think") rather than hiding it behind generic friendliness.
- The icon system is split **on purpose** — don't "clean it up" into one
  consistent system without checking this first:
  - **Dietary/classification info** (vegan/veggie/not-for-us/unknown
    badges, stats, counts) uses **emoji** (🌱🥚🥩❓). The founder found an
    all-SVG, all-green icon system wasn't glanceable enough — distinct
    shape *and* color scans faster than shade-of-green alone.
  - **Everything else** (navigation, decoration, source-type icons) uses
    the custom SVG set in `components/icons.tsx` — no emoji there.

### The five UX principles (founder, 2026-07-24) — read before any design work

1. **Cool, bold and intelligent.** Big confident display type, flat blocks of
   colour, no timid pastel. It should feel like walking into a good café, not
   into a dashboard.
2. **Green leads, pink accents.** Deep forest green carries roughly three
   quarters of any page; pink arrives at full strength as headlines, primary
   buttons, seams and mesh points — never as a pastel wash blended into the
   green.
3. **Green always means plants.** Vegan/vegetarian/veggie signalling is green
   (plus the emoji set) everywhere, without exception. Pink must never carry
   dietary meaning — a pink dish badge could read as "not for you".
4. **Liquid glass + mesh gradient = the intelligence layer.** Use them so the
   product reads as AI without the copy having to say so (see the section
   below for the how and the limits).
5. **AI-assisted, human-verified — never AI slop.** Every surface should make
   it clear a person is behind this: sampling and reviewing classifications,
   working the error log, reading the feedback. Copy credits the AI for what
   it does (reading thousands of menus) and the human for the judgement.

**The standard one-line description of the app** — use this verbatim wherever a
short blurb is needed (meta description, OG/Twitter card, share text, footer):

> Picky — find veggie dishes in any restaurant, instantly. AI-assisted.
> Human-verified.

### "Cool, bold AND futuristic" — the intelligence layer (2026-07-24)

Standing founder directive, learned when a green+pink poster direction came
back "cool and bold, but it doesn't look AI":

- **Bold alone is not enough. The UI must also *look intelligent*.** Flat
  two-colour poster design reads as a nice restaurant brand; this product is
  an AI product and the interface should say so without the copy having to.
- The two devices the founder explicitly asked for (both current in 2026, and
  the reason competitor AI products read as "smart"):
  - **Liquid glass** — translucent panels with a real backdrop blur, a
    hairline light edge and an inner top highlight. Use it on anything that
    represents the machine thinking or accepting input: the URL bar, the live
    analysis/trace panel, status chips, overlays.
  - **Mesh gradients** — soft, blurred multi-point colour fields (with a
    light grain) behind statement sections and section seams, in the existing
    palette only. They are the "ambient intelligence" texture; they must never
    become a purple-indigo AI-slop hero (see the avoid-list below).
- **Constraint: same colour system.** Glass and mesh are built from the
  existing greens and the pink accent — introducing new hues to get the effect
  is not the fix.
- **Legibility outranks the effect.** Glass surfaces still need measured
  contrast for their text, mesh must sit *behind* content and never under
  small type, and both need a `prefers-reduced-motion` path (no perpetual
  drifting).

The green+pink riso direction shipped as **PR #19** (merged 2026-07-24); the
tokens live in `tailwind.config.ts`/`app/globals.css` (`forest`/`paper`/
`azalea`, `.glass`/`.mesh`/`.plate`, `bg-liquid-pink`/`bg-liquid-green`).
Note on the two CTAs: **pink `.btn-cta` = "do the thing"** (Find my veggies),
**green `.btn-guide` = "go to the place"** (View Dublin Guide) — same liquid
treatment, different job; keep them as siblings, don't collapse them.

### Editing homepage copy — the founder does this himself
All homepage prose lives in `lib/home-copy.ts` (rendered by `app/page.tsx`).
The founder edits it directly and asks Claude to proofread + push. Three bugs
recur in his hand-edits — check all three before pushing:
- **Apostrophes break single-quoted strings** (`'we'll…'` fails to build).
  Wrap any copy with an apostrophe in `"double quotes"`. This actually broke
  the PR #19 build.
- **Split-headline fields concatenate with no separator** — each of
  `before`/`accent`/`after` needs its own trailing/leading space, or it renders
  "See allveggie dishesat any restaurant".
- **Two lines meant to read as separate lines** need a separate `<p>` or a
  `block` span in `app/page.tsx`. To keep a long line on one row on desktop
  only, use `md:whitespace-nowrap` — never an unconditional `whitespace-nowrap`
  (it overflows the viewport on mobile).

### Process for any significant redesign
- **Prototype before implementing.** For the Solar redesign, several full
  visual directions were built as one interactive HTML Artifact (same
  screens, different palettes/copy voices, live simulated flows) and
  reviewed with the founder before any app code changed. Repeat this for
  future large visual changes — it's cheap and avoids building the wrong
  direction in real code.
- **Ground "modern"/"current" claims in real research, not assumption.**
  Design trends move fast and training data goes stale; use WebSearch for
  current guidance (favor NN/g-style practitioner sources over vendor
  marketing blogs) before asserting something is or isn't a current best
  practice.
- **Avoid the generic "AI-generated design" tells** unless the founder
  explicitly asks for one of them: a purple-indigo gradient hero on
  white, Inter/Roboto everywhere, a centered hero followed by three equal
  rounded cards, emoji used as decorative section markers. If a new
  layout matches one of these, push for something more considered before
  shipping it.

### Accessibility is a standing bar, not a one-time fix
Learned the hard way during the Solar review — several "looks fine"
choices failed real WCAG numbers:
- **Measure contrast, don't eyeball it.** Compute actual ratios (the
  relative-luminance formula) for any new muted/secondary text color
  against its real background before shipping — some tokens here were
  failing as low as 1.7:1 against a 4.5:1 requirement despite looking
  subtly fine on screen.
- **Respect `prefers-reduced-motion`** for any new animation, especially
  anything that loops indefinitely (live-narration cursors, pulsing
  status dots).
- **Any live/streaming UI needs `aria-live`/`role="log"`** so
  screen-reader users get the same real-time signal sighted users do —
  don't let a "watch it happen" feature go silent for non-visual users.
- **State indicators need a visible, non-hover label**, not just a
  `title` tooltip — hover-only info is invisible on touch devices.

### Feedback loop
The results page has a general "Feedback" button (missing dish / wrong
menu / feature request / other) backed by the wipe-safe
`restaurant_feedback` table (see Data-handling rules). When adding any
major new user-facing surface, consider whether it needs its own feedback
capture point. Known gap as of this writing: nothing yet reads the
submitted feedback besides raw SQL in the Supabase dashboard — a real
export or admin view is still open work.

## When explaining tradeoffs, structure it as

- **What I'm doing and why** (one or two sentences, plain language)
- **What it costs** (dev time / API cost / risk) if non-trivial
- **What you (the user) need to decide, if anything** — otherwise, just
  do it and report what changed.

## Data-handling rules

- **"Wipe the database" never includes spend/monitoring data.** When the
  user asks to clear the database for fresh testing, he means restaurants
  and their menus (sections/dishes) — NOT the record of token usage and
  API costs. Cost history is how we track whether the project is
  affordable; it must survive resets.
- The wipe-proof home for spend is the append-only `ai_usage_log` table
  (added 2026-07-03; no foreign key to restaurants, so wipes can't touch
  it). Cost columns also still live on `restaurants` rows for convenience,
  but the log is the authoritative history.
- Same pattern for user feedback: the `restaurant_feedback` table (added
  2026-07-06, PR #8) is also not foreign-keyed to restaurants, so a wipe
  can never delete a real feature request or bug report just because the
  restaurant it was submitted from got cleared out.
- To wipe safely, use `npx tsx scripts/wipe-menus.ts --yes` — it exports a
  CSV spend backup first (`scripts/backup-spend.ts` → `db/spend-backups/`)
  and refuses to delete anything if that backup fails. Never wipe by
  deleting `restaurants` rows directly.

## Database access control (RLS) — locked down 2026-07-29

**Supabase ships every table in `public` wide open to the `anon` role** — the
key that is designed to be embedded in public websites. Stock grants give it
SELECT/INSERT/UPDATE/DELETE/TRUNCATE, and Row-Level Security is the *only* thing
standing in front of that. On 2026-07-26 Supabase emailed a **critical**
`rls_disabled_in_public` alert: four tables had RLS switched off —
`restaurant_feedback` (free-text user notes, `ip_hash`, `anon_id`) and the three
`eval_*` tables (the human-reviewed ground truth `/admin/eval` measures against).
Anyone with the project URL could have read or deleted all of it.

### The model: server-only, and therefore ZERO policies

The browser **never** talks to Supabase directly. Every read and write goes
through Next.js server code using `SUPABASE_SERVICE_ROLE_KEY` (`lib/db.ts`,
`lib/rate-limit.ts`, `lib/init-dublin.ts`, `app/api/admin/login/route.ts`), and
the service role has BYPASSRLS. So the correct configuration is **RLS enabled
with no policies at all**: RLS on + zero policies = deny everything to
`anon`/`authenticated`, while the app, admin pages and `scripts/` are untouched.

**A policy would *open* access, not restrict it.** Supabase's advisor lists all
14 tables under `rls_enabled_no_policy` at INFO level — that is intentional and
must stay that way. Do not "tidy it up" by adding policies. The only thing that
would justify one is the browser genuinely starting to query Supabase directly,
and that is a decision to raise with the founder, not a refactor.

Two layers, in `supabase/migrations/20260729120000_lock_down_rls.sql` and
`20260729130000_harden_public_functions.sql`, mirrored at the end of
`db/schema.sql` so a fresh bootstrap is born locked:
1. RLS on all 14 tables. The stale `city_guides` "Allow public read" policy was
   dropped — `USING true` ignored the `status` column, so unpublished **draft**
   guides were readable by anyone.
2. `REVOKE ALL` on tables/sequences/functions from `anon`, `authenticated` and
   `PUBLIC`, plus `ALTER DEFAULT PRIVILEGES` so new objects inherit nothing.
   Belt *and* braces on purpose: one accidental "disable RLS" click in the
   dashboard is exactly what caused this, and the revoked grants mean that
   click no longer re-exposes the table.

### The PR checklist

- **Added a table?** RLS must be enabled and it must have no policies. The
  `rls_auto_enable()` event trigger catches new tables automatically — keep it;
  it cannot be called over RPC (it returns `event_trigger`), so ignore the
  advisor's SECURITY DEFINER warning about it.
- **Added a DB function?** Postgres grants `EXECUTE` to `PUBLIC` by default.
  Revoke it. See the trap below.
- **Added a view?** Views are not covered by the table RLS above and can leak
  around it — check it explicitly.
- **Migration touching grants or policies?** Re-run the advisor afterwards
  (command below), don't assume.

### The two traps that made this worse than it looked

1. **Revoking from `anon` and `authenticated` is not enough — you must revoke
   from `PUBLIC`.** Postgres grants function `EXECUTE` to `PUBLIC` by default
   and `anon` inherits it, so a revoke naming only the two roles leaves the
   hole wide open. This is how `prune_parse_attempts(retain_days)` stayed
   callable as `POST /rest/v1/rpc/prune_parse_attempts` with `retain_days=0` —
   an unauthenticated request that would have deleted the entire
   `parse_attempts` history.
2. **A "permission denied" curl proves nothing if your key is empty.** The
   anon key in `.env.local` is literally blank (it is unused — nothing in the
   app reads it), so a test using it returns `No API key found` and *looks*
   like a pass. That is a false negative. Pull a real key from the Management
   API (`/v1/projects/{ref}/api-keys?reveal=true`), test with that, and delete
   it from the scratchpad afterwards. See also the empty-env-var shadow below.

### Verify with the advisor, not by eye

```bash
curl -sS "https://api.supabase.com/v1/projects/ipagpizavkrqoroedkty/advisors/security" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

Expect **0 ERROR/CRITICAL** and only the 14 INFO `rls_enabled_no_policy`
notices. Then confirm both directions, because either alone is misleading:
a real anon key must get `permission denied` on every table, **and** the
service-role path must still read them all. A lockdown that also breaks the app
is not a fix.

## Infra gotchas (Supabase & Vercel) — learned the hard way

**The empty-env-var shadow.** This sandbox's shell exports *empty* values
for secret vars (e.g. `SUPABASE_SERVICE_ROLE_KEY=`) that **shadow** the real
ones in `.env.local`. Two consequences, both real time-sinks:
- One-off scripts must load env with override —
  `dotenv config({ path: '.env.local', override: true })` (see
  `scripts/_preload-env.ts`). Without `override`, the empty shell value wins
  and the DB looks unconfigured/empty.
- A `next dev` server launched from a bare shell inherits those empty vars
  and connects to a misconfigured DB — pages render stale/blank while a
  direct script reads fine (this cost hours chasing a phantom "edit didn't
  save"). Before starting a dev server for verification, load real env first:
  `set -a; . ./.env.local; set +a`. Don't trust a rendered admin page until
  you've ruled this out.

**Applying Supabase migrations.** The direct DB connection is BLOCKED here —
`supabase db push` / `migration list` fail with a connect error
(IPv6/pooler unreachable). Apply DDL via the **Management API** over plain
HTTPS instead:
`POST https://api.supabase.com/v1/projects/{ref}/database/query` with
`Authorization: Bearer $SUPABASE_ACCESS_TOKEN` and body `{ "query": "..." }`.
Make the SQL idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and
also `INSERT ... INTO supabase_migrations.schema_migrations (version, name)`
so a future `db push` skips it. Reconcile against the live schema after.

**CI runs `next build`; our fast checks don't.** `npm run
typecheck`/`lint`/`test` can all pass while `next build` fails in CI —
because build *prerenders* routes, and any DB-reading page or GET route
**without `export const dynamic = 'force-dynamic'`** throws at build time
(CI has no DB creds). It builds fine locally only because your machine has
`.env.local`. So:
- Every page/route that reads the DB needs `export const dynamic =
  'force-dynamic'`; pages that must always show live data also want
  `export const fetchCache = 'force-no-store'`.
- Before pushing a new DB-reading route/page, reproduce CI locally:
  `NEXT_PUBLIC_SUPABASE_URL="" SUPABASE_SERVICE_ROLE_KEY="" npm run build` —
  empty creds surface the same prerender-DB failure CI hits.

**This sandbox's `next build`/`next dev`/`next lint` can silently hang —
don't wait it out, use GitHub Actions instead.** Learned 2026-07-22: while
building the reparse-button PR, `next build`, `next dev`, and `next lint`
each stalled here for minutes with zero output — not a real error, just
wedged, unrelated to the code being tested. `tsc --noEmit` and `vitest`/`npm
test` ran fine in the same session, so they're reasonably reliable locally.
Meanwhile the identical commit's GitHub Actions `check` job (lint +
typecheck + tests + build) finished cleanly in under 2 minutes. So: run the
cheap/reliable local checks first (`npm run typecheck`, `npm test`) to catch
the obvious stuff fast, but don't burn time waiting on a hung local
`build`/`dev`/`lint` — kill it, push the branch, open/update the PR, and
watch CI (`gh pr checks <num>`, or `gh run watch` on the run id) as the real
verdict. If CI fails, fix based on its output and push again. When a change
needs behavioral verification but local `dev`/`build` won't cooperate,
prefer a targeted check over waiting: invoke the route handler function
directly in a one-off script, or write a direct DB assertion test, rather
than trying to force a full local dev/build cycle.

**Vercel env vars.** `vercel env pull` returns BLANK for *every* value in
this sandbox (even non-sensitive ones), so you CANNOT verify a value by
reading it back — confirm env changes by behaviour (deploy + test), not by
pulling. CLI-added vars are stored "Sensitive" (write-only). Feed values on
stdin — a file redirect (`vercel env add NAME production < file`) is the
most reliable — and trust the `✓ Added` confirmation. Env changes only take
effect on the **next** deployment.

## Project reference

For current architecture, stack, and file layout, defer to what's
actually in the repo (`README.md`, `lib/`, `db/schema.sql`) — this file
is about *how to work*, not a snapshot of *what exists*, since the latter
goes stale.
