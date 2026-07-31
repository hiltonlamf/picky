import type { Restaurant, MenuSection, Dish } from '@/types';
import { formatPrice } from '@/lib/format-price';
import { classifyDishRole } from '@/lib/dish-role';

// Guide-facing menu insights — all derived from data we already have, NO LLM.
//
// A diner only sees ONE menu per visit, so a restaurant that sums 44 veg dishes
// across breakfast/lunch/dinner really offers ~11 at any sitting. We therefore
// rank and headline by the BEST SINGLE MENU's veg count, show the per-menu
// breakdown, and highlight a few example dishes (the priciest veg dishes — the
// most expensive item is usually the most substantial, i.e. a "main").
//
// The headline count is COUNTED dishes only — desserts, sauces, plain breads
// and rice are tallied separately as "sides & sweets" (see lib/dish-role.ts).
// They are never hidden, they just stop inflating the number a diner uses to
// judge a restaurant. This module is the single place both the guide card and
// the restaurant page get their figures, so the two can never disagree.

/** Parse a price string ("€7.50", "€29", "12", "8.00") to a number, or null if
 *  there's no usable number (e.g. "Market Price", empty). */
export function parsePrice(price: string | null | undefined): number | null {
  if (!price) return null;
  // Menus write prices in ways that stripping non-digits mangles badly:
  //   '9" €12.99 / 12" €14.99'  -> 912.991214   (a €913 Margherita)
  //   '€8–€11'                  -> 811
  //   '3,75'                    -> 375          (Dutch decimal comma)
  // So: prefer the first number attached to a currency symbol — that skips the
  // 9"/12" pizza sizes — and fall back to the first number otherwise. A comma
  // before one or two digits is a decimal separator, not a thousands one.
  const withCurrency = price.match(/[€£$]\s*(\d+(?:[.,]\d{1,2})?)/);
  const bare = price.match(/\d+(?:[.,]\d{1,2})?/);
  const token = withCurrency?.[1] ?? bare?.[0];
  if (!token) return null;
  const n = parseFloat(token.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** What counts as "veggie" for a diner scanning a menu. `unknown` is included
 *  on purpose — when the AI can't tell (a "soup of the day" with no ingredients
 *  listed), the dish is shown as a maybe-please-confirm rather than dropped, and
 *  the count must match the list. Founder's rule: when in doubt, count it. */
export function isVeg(dish: Pick<Dish, 'classification'>): boolean {
  return (
    dish.classification === 'vegan' ||
    dish.classification === 'vegetarian' ||
    dish.classification === 'unknown'
  );
}

/** A veg dish that belongs in the headline figure — i.e. not a dessert, sauce,
 *  condiment or plain bread/rice. */
export function isCountedVeg(sectionName: string | null | undefined, dish: Dish): boolean {
  return isVeg(dish) && classifyDishRole(sectionName, dish).role === 'counted';
}

// A dish in a bar-snack section priced below this share of the restaurant's
// typical dish is a nibble, not an option. Where mains are ~€20, a €5 plate of
// olives-and-almonds is not what a vegetarian came for.
const NIBBLE_PRICE_RATIO = 0.5;
/** Below this many priced dishes there's no reliable price level to compare to. */
const MIN_PRICES_FOR_TIEBREAK = 4;

/**
 * The restaurant's typical dish price — the MEDIAN of everything priced.
 *
 * Deliberately not "the average of the top 3", which was the first idea: the
 * top of a menu is caviar, seafood towers and sharing lobster, so at Fade
 * Street Social that reads €132 and would have thrown out a €14 tomato salad.
 * A median ignores those outliers.
 */
function medianPrice(sections: MenuSection[]): number | null {
  const prices: number[] = [];
  for (const s of sections) {
    for (const d of liveDishes(s)) {
      const p = parsePrice(d.price);
      if (p !== null && p > 0) prices.push(p);
    }
  }
  if (prices.length < MIN_PRICES_FOR_TIEBREAK) return null;
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

/**
 * Resolves the ambiguous bar-snack cases on price, computing the price level at
 * most once and ONLY if something ambiguous actually turned up — the common
 * case (no bar-snack section) never pays for it.
 *
 * A dish with no price stays counted: we can't judge what we can't see.
 */
function makeNibbleTest(sections: MenuSection[]): (dish: Dish) => boolean {
  let level: number | null | undefined; // undefined = not computed yet
  return (dish) => {
    const price = parsePrice(dish.price);
    if (price === null) return false;
    if (level === undefined) level = medianPrice(sections);
    if (level === null) return false;
    return price < level * NIBBLE_PRICE_RATIO;
  };
}

/** Live (non-deleted) dishes of a section. */
function liveDishes(section: MenuSection): Dish[] {
  return section.dishes.filter((d) => !d.deletedAt);
}

/**
 * Headline figures for a set of sections: veg dishes worth counting, the
 * sides/sweets shown beside them, and how many of the counted ones are vegan.
 * The same dish name counts once (see the de-dupe note in guideInsights).
 *
 * The restaurant page uses this directly so its stat capsule and the guide
 * card can never disagree; guideInsights applies the same logic per menu.
 */
export function headlineCounts(
  sections: MenuSection[],
  /** Sections to take the price level from — pass the whole restaurant when
   *  counting one menu, so a cheap lunch menu isn't judged against itself.
   *  Defaults to the sections being counted. */
  priceContext: MenuSection[] = sections
): {
  counted: number;
  aside: number;
  countedVegan: number;
} {
  const counted = new Set<string>();
  const aside = new Set<string>();
  const vegan = new Set<string>();
  const isNibble = makeNibbleTest(priceContext);
  for (const section of sections) {
    for (const dish of liveDishes(section)) {
      if (!isVeg(dish)) continue;
      const key = normalizeDishName(dish.name) || `#${dish.id}`;
      const verdict = classifyDishRole(section.name, dish);
      const keep = verdict.role === 'counted' && !(verdict.ambiguous && isNibble(dish));
      if (keep) {
        counted.add(key);
        if (dish.classification === 'vegan') vegan.add(key);
      } else {
        aside.add(key);
      }
    }
  }
  // forEach, not for…of: this project compiles below es2015, where iterating a
  // Set directly needs --downlevelIteration.
  counted.forEach((key) => aside.delete(key));
  return { counted: counted.size, aside: aside.size, countedVegan: vegan.size };
}

/** Collapse a dish name to a comparison key: drop parentheticals and standalone
 *  veg markers (V / VG / vegan…) so the same dish across menus dedupes to one. */
function normalizeDishName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(v|vg|ve|vgn|vegan|vegetarian|veg)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

export interface PerMenuVeg {
  /** Source-menu label (Lunch/Dinner/...); null for a single-menu restaurant. */
  label: string | null;
  /** Veg dishes a diner would actually order as a dish. Excludes desserts,
   *  sauces, condiments and plain breads/rice. */
  vegOptions: number;
  /** Veg dishes present on this menu but NOT counted above — shown as
   *  "plus N sides & sweets" rather than dropped. */
  asideOptions: number;
}

export interface HighlightDish {
  name: string;
  /** Display-formatted price ("€24"), or null if the menu doesn't state one. */
  price: string | null;
}

export interface GuideInsights {
  /** Best single menu's COUNTED veg total — the guide headline + ranking key. */
  maxVegOptions: number;
  /** That same menu's sides/sweets tally, shown in small print beside it. */
  asideCount: number;
  /** The best single menu's vegan / vegetarian split (shown once on the card).
   *  Counted dishes only, so it can never exceed maxVegOptions. */
  bestMenu: { label: string | null; vegan: number; vegetarian: number };
  /** Veg options per source menu, in display order. */
  perMenu: PerMenuVeg[];
  /** All live dishes across every menu (sides included). */
  totalDishes: number;
  /** Up to 3 example veg dishes — priciest first (≈ the mains); falls back to
   *  veg dishes in menu order for tasting/prix-fixe menus with no prices. */
  highlights: HighlightDish[];
  /** True when the highlight list isn't a real showcase: fewer than 3 veg
   *  dishes were found at all, or every highlighted dish comes from a
   *  side/dessert/nibble/bread section rather than a main. The card should
   *  show an honest, lighter caption instead of implying these are picks. */
  highlightsAreThin: boolean;
}

const MAX_HIGHLIGHTS = 3;

// Best-effort text match on section names (same pattern as isDrinkSectionName
// in lib/ai.ts) to tell "no real mains here" restaurants apart from a
// legitimate short menu. Substring match, not an exact set, since section
// names vary more here ("Side Dishes", "Sweet Treats", "Bar Snacks").
// Deliberately narrow — English-only, a display nicety not a data check.
// Starters excluded on purpose: they can be substantial.
const NON_MAIN_SECTION_KEYWORDS = [
  'dessert', 'sweet', 'pudding',
  'side',
  'nibble', 'snack', 'bar bites',
  'bread', 'bakery',
];

function isNonMainSectionName(name: string): boolean {
  const lower = name.toLowerCase();
  return NON_MAIN_SECTION_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Compute the guide card's numbers from a restaurant's sections. Groups by
 *  menuLabel so multi-menu restaurants (Lunch/Dinner) report per menu and are
 *  ranked by their best single menu, not the sum. */
export function guideInsights(restaurant: Pick<Restaurant, 'sections'>): GuideInsights {
  // Group sections by menuLabel, preserving first-seen (display) order.
  const order: Array<string | null> = [];
  const byLabel = new Map<string | null, MenuSection[]>();
  for (const s of restaurant.sections) {
    const key = s.menuLabel ?? null;
    if (!byLabel.has(key)) {
      byLabel.set(key, []);
      order.push(key);
    }
    byLabel.get(key)!.push(s);
  }

  // Counting walks sections (not a flat dish list) because a dish's role
  // depends on the section it sits in — "Desserts" is decided at that level.
  //
  // Within a menu the same dish is counted ONCE. Restaurants routinely list a
  // dish twice: Cornerstore's "Tasting Menu – Vegetarian" is its à la carte
  // plates bundled, so crispy tofu, lotus root pickle and four others each
  // appeared twice and the card claimed 11 options where a diner has 6. The
  // highlights list has always de-duped this way (normalizeDishName); the
  // count simply never did.
  //
  // Each menu goes through headlineCounts, the same helper the restaurant page
  // calls — so the card and the page cannot drift apart, including on the
  // price tiebreak. The price level is taken from the WHOLE restaurant, not
  // one menu, so a cheap lunch menu isn't judged against itself.
  const counts = new Map<string | null, ReturnType<typeof headlineCounts>>();
  for (const label of order) {
    counts.set(label, headlineCounts(byLabel.get(label)!, restaurant.sections));
  }
  const perMenu: PerMenuVeg[] = order.map((label) => ({
    label,
    vegOptions: counts.get(label)!.counted,
    asideOptions: counts.get(label)!.aside,
  }));

  // Best single menu = the one with the most COUNTED veg options.
  let bestLabel: string | null = order[0] ?? null;
  let maxVegOptions = 0;
  let asideCount = perMenu[0]?.asideOptions ?? 0;
  for (const m of perMenu) {
    if (m.vegOptions > maxVegOptions) {
      maxVegOptions = m.vegOptions;
      asideCount = m.asideOptions;
      bestLabel = m.label;
    }
  }
  // The vegan split comes from the same counted set as the headline, or the
  // card could read "5 vegan" beside "3 veggie".
  const best = counts.get(bestLabel);
  const bestMenu = {
    label: bestLabel,
    vegan: best?.countedVegan ?? 0,
    vegetarian: (best?.counted ?? 0) - (best?.countedVegan ?? 0),
  };

  const totalDishes = restaurant.sections.flatMap(liveDishes).length;

  // Highlights: a few standout veg dishes, de-duped by normalized name so the
  // same dish on several menus counts once. Priced dishes are ranked priciest-
  // first (most expensive ≈ most substantial ≈ a main); tasting/prix-fixe menus
  // have no per-dish price, so we fall back to veg dishes in menu order rather
  // than showing nothing.
  const seen = new Set<string>();
  type Candidate = { name: string; price: number; displayPrice: string | null; sectionName: string };
  const pricedVeg: Candidate[] = [];
  const unpricedVeg: Candidate[] = [];
  for (const section of restaurant.sections) {
    for (const dish of liveDishes(section)) {
      // Counted dishes only — a card must never headline a naan or a sorbet.
      if (!isCountedVeg(section.name, dish)) continue;
      const key = normalizeDishName(dish.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const price = parsePrice(dish.price);
      const candidate = {
        name: dish.name.trim(),
        price: price ?? 0,
        displayPrice: formatPrice(dish.price),
        sectionName: section.name,
      };
      if (price === null) unpricedVeg.push(candidate);
      else pricedVeg.push(candidate);
    }
  }
  const topHighlights = [...pricedVeg.sort((a, b) => b.price - a.price), ...unpricedVeg].slice(
    0,
    MAX_HIGHLIGHTS
  );
  const highlights: HighlightDish[] = topHighlights.map((h) => ({ name: h.name, price: h.displayPrice }));
  const highlightsAreThin =
    highlights.length < MAX_HIGHLIGHTS || topHighlights.every((h) => isNonMainSectionName(h.sectionName));

  return { maxVegOptions, asideCount, bestMenu, perMenu, totalDishes, highlights, highlightsAreThin };
}
