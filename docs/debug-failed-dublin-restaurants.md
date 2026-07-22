# Debug handoff — 7 Dublin restaurants the pipeline couldn't add

Written 2026-07-20. These 7 trendy Dublin restaurants were run through the **existing** analysis
pipeline (via `scripts/seed-trendy-dublin.ts`) but did not reach the ≥7-dish bar, so they were **not**
added to the guide. This doc is for debugging the app's read/extract pipeline in a separate session —
each restaurant's exact failure, a diagnosis from a quick manual look at the site, and where in the
code to look.

> Nothing here is a code regression from this session's work — these are genuine "hard to read website"
> cases. Re-running them costs real Anthropic money, so debug the **scrape/discover** stages (free)
> first and only re-run the full pipeline once you think you've fixed the root cause.

## Resolution (2026-07-22)

All 7 are now handled, three by real code fixes, four by the `no_menu` outcome (see
`CLAUDE.md`'s no-menu track). Guarded by tests so a future change gets caught automatically:

| Restaurant | Outcome | Regression coverage |
|---|---|---|
| Kicky's | **Fixed** — opening-hours-as-price regex bug + a subpage-dedup bug in `lib/menu-discovery.ts`, both real | `tests/discovery.test.ts` ("kickys.ie bug" describe blocks) — fixture-based, free, runs every push. Live case in `tests/pipeline-cases.json` ("Kicky's") — runs on merge to `main`. |
| Drury Buildings | **Fixed manually** (admin-added PDFs) — live auto-discovery still blocked by a TLS trust-chain gap in Node's bundled CA list (a brand-new 2026 Let's Encrypt root, not yet in any formal root-trust program — deliberately not worked around by trusting it ourselves) | `tests/scraper-fetch-fallback.test.ts` — fixture-based (mocked fetch/reader), free, runs every push. **Not** in the live pipeline suite — see the `comment` field in `pipeline-cases.json` for why, and the manual re-check command. |
| Amai by Viktor | **Fixed manually** (admin-added menus) — not actually an AVIF problem (verified: real JPEGs); the real menu subpages simply aren't linked anywhere crawlable, even via the JS-rendering reader. No code fix is possible. | None practical to write — there's no discoverable link for a fixture to exercise. Re-check manually: `npx tsx scripts/run-pipeline-tests.ts amai`. |
| Glovers Alley, Sprezzatura, Bibi's, Clanbrassil House | **`no_menu` outcome** — genuinely no readable menu / down / closed, per manual site review | `tests/discovery.test.ts`'s "genuinely no menu" describe block covers the zero-candidates precondition these rely on. The `status='no_menu'` classification and cost-saving cache logic itself is DB-backed and verified live (not a vitest unit test — see `scripts/test-admin-actions.ts`'s pattern for the closest analogue: reparse-preservation, which also protects Drury/Amai's admin-added dishes from a future reparse bug). |

---

## The pipeline, in one screen

A restaurant goes through 4 stages. Each failure below is tagged with the stage that broke.

1. **Scrape** — `lib/scraper.ts` → `scrapeRestaurant(url)`. Plain HTTP fetch + Cheerio; can also pull a
   hosted screenshot / JS-rendered read via `lib/reader.ts`. Returns page text, menu links, PDF/image
   URLs, screenshot URL. *Fetch-level failures happen here.*
2. **Discover** — `lib/menu-discovery.ts` → `discoverMenus(scrapeResult)`. Decides what the menu(s)
   are (inline text / subpage / PDF / image) and labels candidates (Haiku). *"Couldn't find a menu"
   failures happen here.*
3. **Extract + classify** — `lib/menu-extract.ts` → `extractAndMerge(candidates, ctx)`. Retry ladder:
   primary source → PDF → images → screenshot → **Sonnet** escalation. Reads dishes and classifies
   them (Haiku), then a Sonnet veg-safety audit. *"Menu found but no dishes" / thin results happen here.*
4. **Save** — `lib/db.ts` → `saveClassifiedMenu(...)`. Writes sections + dishes, sets `status='done'`.

Models (confirmed): discovery + extraction = **Haiku** (`claude-haiku-4-5`); escalation + veg audit =
**Sonnet** (`claude-sonnet-4-6`). See `lib/ai.ts`.

### How to reproduce one restaurant for debugging

- **Cheapest (no AI):** isolate the scrape stage with `scripts/test-scraper.ts` to see exactly what
  `scrapeRestaurant()` returns for a URL (page text, menu links, whether a screenshot was captured).
  This alone tells you if the problem is fetch-level, JS-rendering, or a missing menu link — for free.
- **Full pipeline (spends money):** the normal user flow — paste the URL into the app's search — runs
  the exact same code. Or add a single `{ name, url }` to a temporary list and run
  `npx tsx scripts/seed-trendy-dublin.ts --yes --limit 1`.
- Every attempt (success or failure) is logged to `ai_usage_log`; reconcile spend against the Console.

---

## Summary

| Restaurant | Website | Stage that broke | Stored error / result |
|---|---|---|---|
| Amai by Viktor | https://amaibyviktor.ie | Extract | `done`, **1 dish** (tasting menu read as one dish) |
| Glovers Alley | https://gloversalley.com | Discover | "We couldn't read a food menu on this website…" |
| Sprezzatura | https://sprezzaturadublin.ie | Discover/Extract | "We couldn't read a food menu on this website…" |
| Kicky's | https://kickys.ie | Discover/Extract | "We couldn't read a food menu on this website…" |
| Bibi's | https://bibis.ie | Discover | "We couldn't read a food menu on this website…" |
| Drury Buildings | https://drurybuildings.com | **Scrape (fetch)** | "fetch failed" |
| Clanbrassil House | https://clanbrassilhouse.com | Scrape/Discover | "We couldn't read a food menu on this website…" |

Root causes cluster into four buckets: **JS-rendered menus**, **menu on a subpage discovery didn't
reach**, a **TLS/fetch failure**, and a **tasting-menu-as-one-dish** extraction. Details below.

---

## Per-restaurant detail

### 1. Amai by Viktor — tasting-menu-as-one-dish (Extract)
- **URL:** https://amaibyviktor.ie · **Result:** `status=done`, 1 dish, no error.
- **What the site is:** a Brazilian-Irish fine-dining spot that serves a single fixed **tasting menu**.
  Homepage has an "Explore Menu" link; the menu is a set multi-course experience, not an à la carte list.
- **Why it failed the bar:** the extractor collapsed the whole tasting menu into **one "dish"**, so it
  came back with 1 (< 7). This is the exact failure mode the guide's review-flag heuristic is meant to
  catch (`lib/review-flags.ts` → `menu_as_dish`).
- **Where to look:** `lib/menu-extract.ts` / the extraction prompt in `lib/ai.ts`. The fix is a prompt/
  logic change so a tasting menu's **individual courses become individual dishes** (each course = a dish),
  rather than one block. Consider detecting "N-course tasting menu" and expanding courses.
- **Note:** even fixed, a tasting menu may only yield ~5–8 courses — decide whether tasting-only
  restaurants should be exempt from the ≥7 bar, or shown with a "tasting menu" treatment.
- Hilton's Manual Review: 
The menus are indeed listed on the website on three separate links. 
1. The SamBar menu: https://www.amaibyviktor.ie/aut
2. The vegetarian menu: https://www.amaibyviktor.ie/vegertian-menu
3. Lunch menu including two images. One of them is a vegetarian lunch menu and the other is a normal lunch menu: https://www.amaibyviktor.ie/copy-of-the-folklore-menu
4. Each of these menus is saved as images in this format: .avif, which might be causing the bug. 

### 2. Glovers Alley — menu not on the homepage (Discover)
- **URL:** https://gloversalley.com · **Error:** "couldn't read a food menu…"
- **Recon:** the homepage is essentially a landing page (a "Book Now" CTA); **no menu content on the
  root page**. The real menu lives on a subpage discovery didn't follow to (this is a Michelin
  fine-dining site that publishes sample menus).
- **Where to look:** `lib/menu-discovery.ts` — the menu-link/nav-crawl scoring. It needs to find and
  follow the sample-menu subpage. **Quick test:** find the actual menu URL by hand and confirm the
  pipeline succeeds when given it directly (the app's "paste a direct menu link" path).
- Hilton's Manual Review: the website has been taken down. It says that "the website is coming on the second of September. Please keep in touch." That means there are actually no legitimate menus on the website. When a user asked for this restaurant in this URL, the correct response is that there is no menu listed on this website. We shouldn't throw an error. We should throw a certain response that there is no menu on the website and ask if the user knows exactly where the menu is, because we cannot find it. 

### 3. Sprezzatura — JS-rendered menu (Discover/Extract)
- **URL:** https://sprezzaturadublin.ie · **Error:** "couldn't read a food menu…"
- **Recon:** the menu is an on-page `#menu` section with category headers (Small Plates, Fresh Pasta,
  Drinks) but the **actual dish names/prices aren't in the static HTML** — they're JavaScript-loaded.
  A plain fetch sees the headers, not the dishes.
- **Where to look:** the JS-rendering path. `scrapeRestaurant` / `lib/reader.ts` — does it fall back to
  a rendered read / screenshot when the static HTML has section headers but no dish text? The
  screenshot→vision rung in `extractAndMerge` should catch this if a screenshot is captured; check
  whether one was.
- Hilton's Manual Review: when the menu button on this website was clicked, I observed that there are actually no dishes listed. Again, the menu is not clearly listed on the website. When the user requested this menu to be analyzed, the correct answer is that this restaurant doesn't have its menu clearly listed. We should give the answer to the user and ask if they know exactly where the menu is, because they might know an alternative way to do it. That should be the same response as restaurant number two. 

### 4. Kicky's — JS-rendered menu on a dedicated page (Discover/Extract)
- **URL:** https://kickys.ie · **Menu page:** https://kickys.ie/our-menus/ · **Error:** "couldn't read…"
- **Recon:** dedicated `/our-menus/` page, but content is **dynamically rendered** — static HTML has
  only nav links, dishes load via JS ("TODAY'S MENU"). Same class of problem as Sprezzatura.
- **Where to look:** same JS-render/screenshot fallback. Also confirm discovery follows `/our-menus/`.
- Hilton's Manual Review: the menus are clearly listed on the website on this link (https://kickys.ie/our-menus/). There are five buttons at the top of the page: a la carte, a taste of kick's, groups, drinks, wine. We should be able to analyze the three menus - a la carte, a taste of kick's, groups. The menus are written in text format after each button is clicked, so it should be quite easy to analyze. 

### 5. Bibi's — menu on `/menu/`, format unconfirmed (Discover)
- **URL:** https://bibis.ie · **Menu page:** https://bibis.ie/menu/ · **Error:** "couldn't read…"
- **Recon:** there's a dedicated `/menu/` page, but its format couldn't be confirmed from the homepage
  — likely an **image or PDF menu** (common for cafés) or JS-rendered. Homepage shows no menu text.
- **Where to look:** fetch `/menu/` directly and inspect: if it's an image/PDF, the image/PDF rungs of
  `extractAndMerge` should handle it — check whether discovery passed the image/PDF URL through. If it's
  JS, same as #3/#4.
- Hilton's manual review: indeed, no clear menus are listed on their websites, even on the menu page. We should return the same message as restaurants 2 and 3. When a user asks for this restaurant to be scraped, we should save in the database that we could not find the menus and then flag it to the admin to confirm that is true. The admin can confirm that is true, and then when the user asks for it again, we will return the same "No menu found" response rather than reanalyzing the website that doesn't have the menu. If a user manually flags that this restaurant does have a menu, then the admin should be able to review it. Try to think about a way to save in the database that there's no menu in this website. So when we throw a message back to the user saying that there's no menu, there should be a way for them to link it to the specific menu or upload an imag or pdf if they are aware of any. 

### 6. Drury Buildings — TLS / fetch failure (Scrape)
- **URL:** https://drurybuildings.com · **Error:** "fetch failed" (note: different from the others).
- **Recon:** a manual fetch failed with **`unable to get local issuer certificate`** — a TLS
  certificate-chain problem on the site (or our fetch not trusting its chain). The scrape never got a
  page at all, so discovery/extract never ran.
- **Where to look:** the fetch layer in `lib/scraper.ts` / `lib/reader.ts`. Options: verify the site's
  cert chain, try `www.` vs apex, or handle incomplete-chain sites. **This is the only fetch-level
  failure of the seven** — fix it at the HTTP layer, not the menu layer.
- Hilton's Manual Review: menus are clearly listed on the website, on this link: https://drurybuildings.com/kitchen-menus/. they are posted as PDF files which can be navigated using the buttons on this link. The button names are:
- Food Menu
- Dessert Menu
- Group Menu
- Christmas Menu
Here are the links to the PDF files which show the clear menus for this restaurant:
 https://drurybuildings.com/wp-content/uploads/2026/06/FOOD-MENU-A4-JUNE-HELVETICA-2026.pdf
 https://drurybuildings.com/wp-content/uploads/2026/06/BOXER-A4-WEBSITE-JUNE-26.pdf
 https://drurybuildings.com/wp-content/uploads/2025/10/Web-Gatherings_Group.pdf
 https://drurybuildings.com/wp-content/uploads/2025/10/Web-Christmas-Gatherings_Group.pdf

### 7. Clanbrassil House — possibly wrong/dead domain (Scrape/Discover)
- **URL:** https://clanbrassilhouse.com · **Error:** "couldn't read a food menu…"
- **Recon:** a manual fetch of the root returned **HTTP 404**. Clanbrassil House's web presence is
  largely social (Facebook / review sites) — `clanbrassilhouse.com` may be **parked, changed, or not
  its real site**. This one may not be fixable via the pipeline at all.
- **Where to look:** first verify the restaurant's **actual** website (it may not have one). If it's
  social-only, it's out of scope for the scraper — either skip it or add its menu manually via the
  admin "Add a menu URL or file" flow.
- Hilton's manual review: this restaurant is actually closed. The website is a dead website. In this case, we should not tell the user that we cannot find the menus. Instead, we should tell the user that the website is dead and ask them to confirm and provide a link to the website if they do not think so. 

---

## Suggested priority (highest-leverage first)

1. **JS-rendered menus** (Sprezzatura, Kicky's, maybe Bibi's) — this is the biggest recurring bucket
   across all Dublin restaurants, not just these. Making the scraper reliably read JS-rendered menus
   (rendered read or screenshot→vision) likely fixes several at once. Look at `lib/reader.ts` +
   the screenshot rung of `lib/menu-extract.ts`.
2. **Subpage discovery** (Glovers Alley, Bibi's) — follow the real menu subpage when the homepage is a
   landing page. `lib/menu-discovery.ts`.
3. **Tasting-menu expansion** (Amai) — extraction prompt in `lib/ai.ts` / `lib/menu-extract.ts`.
4. **TLS fetch** (Drury Buildings) — `lib/scraper.ts` fetch layer.
5. **Verify the domain** (Clanbrassil House) — may be unfixable / manual-add only.

## Fastest path to re-adding them once fixed

For any that publish a menu at a specific URL, the app already supports **pasting a direct menu link**
(the admin review screen's "Add a menu URL or file", or the public search). That bypasses the
homepage-discovery problem for #2/#5 today, without any code change — worth doing for the ones you want
live now while the scraper fixes land.
