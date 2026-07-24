# Known gap: JS-rendered + "lies-about-its-language" restaurant sites

**Status:** open, deferred to a future PR/session (surfaced 2026-07-24 while
seeding the Amsterdam guide).
**Example restaurant:** [ramen-ya.nl](https://ramen-ya.nl/) (Amsterdam).

## Symptom

Ramen-ya came back from the pipeline as **`status=done`, 4 dishes,
`menu_language=Dutch`** — far too few dishes for a ramen restaurant, so it
correctly landed in the guide workspace's **"Needs attention"** list (and would
be auto-hidden from the public guide by the `< MIN_GUIDE_DISHES` gate). One of
the 4 dishes was **"Sesam kip ramen"** ("kip" = Dutch for chicken), with an
English description — so the Dutch→English description fallback *did* fire.

## Two independent root causes

### 1. The menu is JavaScript-rendered (the bigger problem)
`ramen-ya.nl` is a **WordPress + Elementor** site. The `/menu/` page's **static
HTML has 0 price tokens (`€`) and almost no dish text** — the menu is injected
by JS into **swiper carousels + tabs**, revealed progressively as the user
swipes/clicks. Our reader captured only a thin slice → 4 dishes. This is a
**rendering** gap, not a language one: even a perfect English version would
still under-read the same way today. This is the same class of issue as the
deferred Kicky's "JS-tabs" fix (see the no-menu deferred-fixes note).

### 2. The page declares English but serves Dutch content
The HTML declares `<html lang="en-GB">` and exposes **both** `hreflang="en"`
and `hreflang="nl"` alternates. But the content the reader actually rendered
came through **Dutch**. Our English-variant preference
(`findEnglishVariant` in `lib/scraper.ts`) keys off `<html lang>`: because it
says `en-*`, we conclude "already English" and **don't switch** — so we ingest
Dutch content anyway. The `lang` attribute effectively lies (or is stale
relative to the JS-rendered body / geo-defaulting to NL from a datacenter IP).

## What already works (don't re-do)
- **Translation fallback:** Dutch dish kept as `name`, English translation in
  `description` — working (prompt rule in `lib/ai.ts`, MULTI-LANGUAGE section).
- **Safety:** thin menu is flagged, not silently published (the
  `MIN_GUIDE_DISHES` gate + "Needs attention" queue). Reputation-safe.
- **Common multilingual case:** a site that honestly declares itself non-English
  and offers an English link IS handled — verified on Blauw Amsterdam
  (`restaurantblauw.nl`), which switched to English and returned 51 dishes.

## Options to fix (for the next session to evaluate)

1. **Cheapest, already-built (no code):** for these stubborn sites use the
   existing **"Add a menu URL or file"** on the review screen — point it at
   `/menu/` directly or upload a screenshot/PDF of the menu.
2. **Language mismatch retry (medium):** after extraction, if the detected menu
   language is non-English **and** the scrape saw an English `hreflang`
   alternate we didn't use, retry extraction against that English URL. Targeted
   (only fires on the mismatch) so the extra AI cost is bounded.
3. **Better render for carousel/tab menus (most work):** drive the reader to
   expand Elementor tabs/swiper slides, or do a full-page screenshot → vision
   extraction of the fully-rendered menu. Higher dev + AI cost per tricky site.

## Recommendation
Don't build 2/3 speculatively. Finish seeding Amsterdam, measure how many of the
~30 restaurants actually hit the JS-carousel pattern (likely a minority), and
clear those with option 1. If it's common, do option 2 first (higher value,
lower cost than option 3).

## Relevant code
- `lib/scraper.ts` — `findEnglishVariant()`, `scrapeHtmlPage()` (lang switch +
  reader/screenshot fallback).
- `lib/menu-discovery.ts` — candidate discovery + `textLooksLikeMenu`.
- `lib/ai.ts` — `SYSTEM_PROMPT` MULTI-LANGUAGE rules.
- `lib/review-flags.ts` — `MIN_GUIDE_DISHES`, the thin-menu gate.
