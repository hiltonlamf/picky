# Instrumentation follow-ups after PR #21

**Context:** PR #21 (merged 2026-07-26) shipped the analytics foundation, the funnel, error tracking, the cost-accounting fix, surveys, dashboards, and `/admin/searches`. Everything below is what was deliberately left, plus what the new instrumentation surfaced once it was live.

Ordered by value, not by effort.

---

## 1. ~$0.20/day of AI spend with no user behind it 💰

**This is the most valuable item here, and it is only visible because of the cost fix.**

`ai_usage_log` shows a steady drip of API calls with no restaurant and no URL attached, running around the clock at roughly six-minute intervals:

| Day | Unattributed calls | Cost |
|---|---|---|
| 2026-07-25 | 53 | $0.209 |
| 2026-07-26 | 77 | $0.252 |
| 2026-07-27 | 54 | $0.158 |
| 2026-07-28 | 96 | $0.317 |
| 2026-07-29 | 39 | $0.135 |

**≈ $0.21/day → roughly $6/month, and it scales with nothing.** No user requested any of it. For comparison, a real user analysis costs $0.03–$0.07, so this is the equivalent of ~4 free analyses a day that nobody sees.

They are unattributed precisely *because* nothing requested them: spend attribution rides on AsyncLocalStorage from a request, and these calls originate outside any request. That is the design degrading safely — the money is still counted — but it also fingerprints them as background work.

The token signatures repeat (`622/72`, `1891/…`, `645/135`, `2159/…`, `1599/…`, `2160/45`, `1600/…`), which suggests **the same restaurant being re-analysed over and over** rather than varied work.

**Two candidate causes, neither confirmed:**
- `app/dublin/page.tsx:19` — `export const revalidate = 300`. Every 5 minutes the page regenerates; if that path touches pending restaurants it could trigger analysis.
- `instrumentation.ts` → `seedDublinInBackground()` → `initDublinRestaurants()`, which runs on server start and makes AI calls outside any request.

**How to investigate:**
1. `select date_trunc('hour', created_at), count(*), sum(cost_usd) from ai_usage_log where restaurant_id is null and url is null group by 1 order by 1 desc` — confirm the cadence is machine-regular rather than bursty.
2. Correlate with `restaurants.updated_at` to see *which* restaurant keeps being re-analysed.
3. Read `lib/init-dublin.ts` for its re-entry guard: does it skip restaurants already `done`, or re-analyse on every boot?
4. Wrap whatever it is in `withSpendContext` (`lib/ai-spend.ts`) so it is attributed rather than anonymous, even after the loop is fixed.

CLAUDE.md already names this failure mode: *"Watch for runaway loops, unbounded retries, or accidental fan-out — these are the failure modes that turn into surprise bills."* Worth doing before the rollout scales.

---

## 2. The three PostHog alerts (deliberately not built)

Dashboards are pull; you have to remember to open them. Alerts push. Three were specified but **not created on purpose**: thresholds set against the pre-rollout baseline (14 people, 17 searches) would fire constantly and train you to ignore them.

Build these once there is **a week of real traffic** to calibrate against:

| Alert | Fires when | Why it matters |
|---|---|---|
| Error spike | `error_shown` + `app_crashed` cross a threshold in an hour | The obvious one |
| **Task-success collapse** | `results_viewed(outcome=menu)` ÷ `search_submitted` drops below ~60% on a rolling day | **The important one.** A pipeline regression does not throw — the reader going down just quietly stops finding menus. No error alert would catch it. |
| Thin-menu spike | share of `results_viewed` with `is_thin` crosses a threshold | The failure users notice most |

PostHog alerts attach to an insight; all three insights already exist on dashboards ② and ③. Set thresholds from the actual observed distribution, not a guess.

---

## 3. Spend rows carry `restaurant_id` and `url` but not `restaurant_name`

Minor, ~5 minutes. `updateSpendContext` is called with `{ url }` and `{ restaurantId }` in the parse routes but never `{ restaurantName }`, so `/admin` cost views show a URL where a name would read better. `app/api/submit-menu/route.ts` already passes the name — copy that.

Confirmed working post-merge: `daata.ie` (3 calls, ~$0.066) and `scottsdublin.ie` (4 calls, $0.034) both attributed correctly.

---

## 4. Product findings parked during the analytics work

Flagged and deliberately not chased, at the founder's request.

**a. `hunan.ie` — discovery missed an obvious `/menus/` link.** Discovery "succeeded" with category `image`: it decided the homepage *pictures* were the menu and ran OCR, instead of following the `/menus/` link a human finds instantly. The failed attempt cost **$0.038 and produced nothing**; the manually-supplied link then cost another $0.037. **The miss doubled the cost of that restaurant** — and this is #2 in the quality bar ("a valid link must not simply fail"). Worth checking whether `MENU_LINK_KEYWORDS` scoring in `lib/scraper.ts` is being outranked by the image path.

**b. The thin-menu threshold of 7 is probably too low.** `hunan.ie/menus/` returned **9 dishes** for a Chinese restaurant — almost certainly a partial read — and did not trip `is_thin`. Now that `results_viewed.dish_count` and `parse_attempts.dish_count` are recorded, set the threshold from the real distribution rather than a guess. Note it may need to vary by cuisine.

**c. Two `$dead_click` events on the results page.** PostHog recorded a visitor clicking something twice that did nothing. Cheap to investigate via session replay (now enabled at 50% sampling), and dead clicks are a direct UX signal.

---

## 5. Admin session token

Separate document: **`docs/admin-session-token.md`**. The admin cookie is `sha256(ADMIN_PASSWORD)` — not revocable without changing the password, and crackable back to the password if disclosed. Not remotely exploitable; has a full design and step list in that file.

---

## What is already confirmed working (do not re-verify)

Verified against real production traffic, not just tests:

- **Cookieless visit counting + consent gating**, both client and server. Verified three times, including the decline path.
- **SPA pageviews** — `/` → `/dublin` → `/restaurant/x` records three, not one.
- **The `/ingest` proxy** (the cookie-stripping route handler) — 39 events delivered end to end.
- **The full funnel** — `search_submitted → analysis_completed → results_viewed → results_engaged`, plus `no_menu_result` and `user_menu_submission_succeeded`.
- **Cost accounting** — 11 rows for one analysis where the old code logged a fraction. `daata.ie` (PDF, 49 dishes) and `scottsdublin.ie` (JS, 27 dishes) both fully traced.
- **`parse_attempts` taxonomy** — `outcome`/`dish_count`/`anon_id` populate on real analyses; discover rows correctly carry no outcome.
- **Surveys** — `survey shown` observed in production.

**Verification method that matters:** five bugs shipped past a green build and a full test suite in this work. Every one was caught by querying what actually landed after a real run — HogQL against PostHog, plus `ai_usage_log` and `parse_attempts`. See the "Verification" section in CLAUDE.md. Green tests are necessary and not sufficient.

---

## One observation worth a decision, not a task

`daata.ie` took **78 seconds** end to end (20.6s discover + 57.6s analyze). `analysis_abandoned` now records `elapsed_ms`, so after some real traffic dashboard ② will show how long people actually wait before giving up. If the median abandonment lands below 78s, the wait — not the pipeline — is the biggest thing between a visitor and a result.
