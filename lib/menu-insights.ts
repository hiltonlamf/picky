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
  const cleaned = price.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
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
export function headlineCounts(sections: MenuSection[]): {
  counted: number;
  aside: number;
  countedVegan: number;
} {
  const counted = new Set<string>();
  const aside = new Set<string>();
  const vegan = new Set<string>();
  for (const section of sections) {
    for (const dish of liveDishes(section)) {
      if (!isVeg(dish)) continue;
      const key = normalizeDishName(dish.name) || `#${dish.id}`;
      if (isCountedVeg(section.name, dish)) {
        counted.add(key);
        if (dish.classification === 'vegan') vegan.add(key);
      } else {
        aside.add(key);
      }
    }
  }
  for (const key of counted) aside.delete(key);
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
  const perMenu: PerMenuVeg[] = order.map((label) => {
    const countedSeen = new Set<string>();
    const asideSeen = new Set<string>();
    for (const section of byLabel.get(label)!) {
      for (const dish of liveDishes(section)) {
        if (!isVeg(dish)) continue;
        // Fall back to the raw name so an unnameable dish still counts once.
        const key = normalizeDishName(dish.name) || `#${dish.id}`;
        (isCountedVeg(section.name, dish) ? countedSeen : asideSeen).add(key);
      }
    }
    // A dish counted as a real option shouldn't also swell the aside tally.
    for (const key of countedSeen) asideSeen.delete(key);
    return { label, vegOptions: countedSeen.size, asideOptions: asideSeen.size };
  });

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
  // The vegan/veg split must come from the same counted set as the headline,
  // or the card could read "5 vegan" beside "3 veggie".
  // De-duped the same way, or "5 vegan" could sit beside a headline of 3.
  const bestSeen = new Set<string>();
  const bestCounted: Dish[] = [];
  for (const s of byLabel.get(bestLabel) ?? []) {
    for (const d of liveDishes(s)) {
      if (!isCountedVeg(s.name, d)) continue;
      const key = normalizeDishName(d.name) || `#${d.id}`;
      if (bestSeen.has(key)) continue;
      bestSeen.add(key);
      bestCounted.push(d);
    }
  }
  const bestMenu = {
    label: bestLabel,
    vegan: bestCounted.filter((d) => d.classification === 'vegan').length,
    vegetarian: bestCounted.filter((d) => d.classification === 'vegetarian').length,
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
