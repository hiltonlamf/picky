import type { Restaurant, MenuSection, Dish } from '@/types';
import { formatPrice } from '@/lib/format-price';
import { classifyDishRole } from '@/lib/dish-role';
import { modifierDishes } from '@/lib/menu-modifiers';
import { effectiveDietaryClassification } from '@/lib/dietary-overrides';

// Guide-facing menu insights — all derived from data we already have, NO LLM.
//
// A diner only sees ONE menu per visit, so a restaurant that sums 44 veg dishes
// across breakfast/lunch/dinner really offers ~11 at any sitting. We therefore
// rank and headline by the BEST SINGLE MENU's veg count, show the per-menu
// breakdown, and highlight a few example dishes. Section meaning comes first:
// mains/curries/stir-fries/noodles outrank starters and sides even when the
// extractor could not attach a price. Price ranks dishes WITHIN that semantic
// tier; it is evidence of substance, not the definition of it.
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
export function isVeg(
  dish: Pick<Dish, 'name' | 'description' | 'classification'>,
  sectionName?: string | null
): boolean {
  const classification = effectiveDietaryClassification(sectionName, dish);
  return (
    classification === 'vegan' ||
    classification === 'vegetarian' ||
    classification === 'unknown'
  );
}

/** A veg dish that belongs in the headline figure — i.e. not a dessert, sauce,
 *  condiment or plain bread/rice. */
export function isCountedVeg(sectionName: string | null | undefined, dish: Dish): boolean {
  return isVeg(dish, sectionName) && classifyDishRole(sectionName, dish).role === 'counted';
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
    const modifiers = modifierDishes(s);
    for (const d of liveDishes(s)) {
      if (modifiers.has(d)) continue;
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
 * Settles the ambiguous cases on price, computing the price level at most once
 * and ONLY if something ambiguous actually turned up — the common restaurant
 * (no bar-snack section, no dish named "… sauce") never pays for it.
 *
 * Returns true when the dish is CHEAP relative to the menu, i.e. not a real
 * dish. Undecidable (no price, or too few prices to compare against) returns
 * null, and the caller keeps the name-based default.
 */
function makePriceTest(sections: MenuSection[]): (dish: Dish) => boolean | null {
  let level: number | null | undefined; // undefined = not computed yet
  return (dish) => {
    const price = parsePrice(dish.price);
    if (price === null) return null;
    if (level === undefined) level = medianPrice(sections);
    if (level === null) return null;
    return price < level * NIBBLE_PRICE_RATIO;
  };
}

/** Final verdict for one dish, applying the price tiebreak where the name alone
 *  was not enough. */
function isCountedWithPrice(
  sectionName: string,
  dish: Dish,
  priceTest: (dish: Dish) => boolean | null
): boolean {
  const verdict = classifyDishRole(sectionName, dish);
  if (!verdict.ambiguous) return verdict.role === 'counted';
  const cheap = priceTest(dish);
  // No price to go on — fall back to what the name suggested.
  if (cheap === null) return verdict.role === 'counted';
  return !cheap;
}

/**
 * The product's real verdict for one dish, price tiebreak included, bound to a
 * restaurant's whole menu for the price context.
 *
 * Exported for scripts/audit-dish-roles.ts. The report used to bucket dishes on
 * `classifyDishRole().role` alone, which ignores the tiebreak — so a €20.50
 * flatbread showed as excluded when the site counts it. A review artifact that
 * disagrees with the product is worse than none.
 */
export function makeCountedTest(
  priceContext: MenuSection[]
): (sectionName: string | null | undefined, dish: Dish) => boolean {
  const priceTest = makePriceTest(priceContext);
  const modifiers = new Set<Dish>();
  for (const section of priceContext) {
    modifierDishes(section).forEach((dish) => modifiers.add(dish));
  }
  return (sectionName, dish) =>
    !modifiers.has(dish) && isCountedWithPrice(sectionName ?? '', dish, priceTest);
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
export interface CategoryTally {
  /** Dishes worth counting as an option. */
  counted: number;
  /** Sides, sauces and sweets — shown, never counted. */
  aside: number;
}

export interface MenuTallies {
  /** Distinct dishes on this menu, whatever their diet. */
  all: number;
  veg: CategoryTally;
  vegan: CategoryTally;
}

/**
 * Every figure the restaurant page and the guide card show, from one walk of
 * the menu, so no surface can compute its own variant.
 *
 * De-duplication is the part that is easy to get wrong and did get wrong: Fade
 * Street Social lists "New Season Heritage Tomatoes" under both TO START and
 * VEGETARIAN / VEGAN on the same menu. The card reported 9 and a page tally
 * that skipped the de-dupe reported 10 — one dish, two rows, and the diner has
 * nine things to choose from. The number means DISTINCT DISHES, everywhere.
 */
export function menuTallies(
  sections: MenuSection[],
  /** Sections to take the price level from — pass the whole restaurant when
   *  counting one menu, so a cheap lunch menu isn't judged against itself.
   *  Defaults to the sections being counted. */
  priceContext: MenuSection[] = sections
): MenuTallies {
  const all = new Set<string>();
  const counted = new Set<string>();
  const aside = new Set<string>();
  const veganCounted = new Set<string>();
  const veganAside = new Set<string>();
  const priceTest = makePriceTest(priceContext);
  for (const section of sections) {
    const modifiers = modifierDishes(section);
    for (const dish of liveDishes(section)) {
      if (modifiers.has(dish)) continue;
      const key = dishKey(dish);
      all.add(key);
      if (!isVeg(dish, section.name)) continue;
      const vegan = dish.classification === 'vegan';
      if (isCountedWithPrice(section.name, dish, priceTest)) {
        counted.add(key);
        if (vegan) veganCounted.add(key);
      } else {
        aside.add(key);
        if (vegan) veganAside.add(key);
      }
    }
  }
  // A dish counted anywhere on the menu is counted, even if another section
  // lists it somewhere that reads like a side.
  // forEach, not for…of: this project compiles below es2015, where iterating a
  // Set directly needs --downlevelIteration.
  counted.forEach((key) => aside.delete(key));
  veganCounted.forEach((key) => veganAside.delete(key));

  return {
    all: all.size,
    veg: { counted: counted.size, aside: aside.size },
    vegan: { counted: veganCounted.size, aside: veganAside.size },
  };
}

/** Stable identity for a dish across sections — the name, or its id when the
 *  name normalises to nothing. */
function dishKey(dish: Dish): string {
  return normalizeDishName(dish.name) || `#${dish.id}`;
}

/** The guide card's three figures, derived from the same walk. */
export function headlineCounts(
  sections: MenuSection[],
  priceContext: MenuSection[] = sections
): { counted: number; aside: number; countedVegan: number } {
  const t = menuTallies(sections, priceContext);
  return { counted: t.veg.counted, aside: t.veg.aside, countedVegan: t.vegan.counted };
}

/** Whether a dish is one of the COUNTED ones, for marking it in the list. */
export function isAsideDish(
  sectionName: string | null | undefined,
  dish: Dish,
  priceContext: MenuSection[]
): boolean {
  if (!isVeg(dish, sectionName)) return false;
  const section = priceContext.find((candidate) =>
    candidate.name === (sectionName ?? '') && candidate.dishes.includes(dish)
  );
  if (section && modifierDishes(section).has(dish)) return false;
  return !makeCountedTest(priceContext)(sectionName, dish);
}

/**
 * The veg dishes of a menu, split the way every surface presents them and
 * de-duplicated the way every surface counts them.
 *
 * The share message builds its own lists and used to count rows, so a menu that
 * lists one dish under two sections promised one more dish than the page shows.
 * Same walk, same keys, same answer.
 */
export function splitVegDishes(
  sections: MenuSection[],
  priceContext: MenuSection[] = sections
): { counted: Dish[]; aside: Dish[] } {
  const priceTest = makePriceTest(priceContext);
  const seen: Record<string, true> = {};
  const counted: Dish[] = [];
  const asideByKey: Record<string, Dish> = {};
  const asideOrder: string[] = [];

  for (const section of sections) {
    const modifiers = modifierDishes(section);
    for (const dish of liveDishes(section)) {
      if (modifiers.has(dish)) continue;
      if (!isVeg(dish, section.name)) continue;
      const key = dishKey(dish);
      if (seen[key]) continue;
      if (isCountedWithPrice(section.name, dish, priceTest)) {
        seen[key] = true;
        delete asideByKey[key]; // counted anywhere wins, as in menuTallies
        counted.push(dish);
      } else if (!asideByKey[key]) {
        asideByKey[key] = dish;
        asideOrder.push(key);
      }
    }
  }
  const aside = asideOrder.map((k) => asideByKey[k]).filter(Boolean);
  return { counted, aside };
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
  /** Up to 3 example veg dishes — known main sections first, then price within
   *  that tier. Other courses fill any slots left after the mains. */
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

// Strong menu-language signals that a section contains the core of the meal.
// These beat price when choosing highlights: an unpriced curry is still a more
// representative Thai dinner than a €10 spring roll. Kept to section names,
// never dish names, so "side of curry sauce" cannot promote itself.
const EXPLICIT_MAIN_SECTION_RE =
  /\b(?:mains?|main courses?|large(?:r)? (?:dishes|plates)|principal dishes?|signature dishes?|chef'?s specials?)\b/i;

const CUISINE_MAIN_SECTION_PATTERNS = [
  // Generic course headings, including the languages seen in our Dublin and
  // Amsterdam menus. "Entrée" is deliberately absent: it means a starter on
  // French menus and a main on American ones, so it is not a safe signal.
  /\b(?:hoofdgerechten?|hoofd|plats? principaux?|les plats|platos? principales?|piatti principali|hauptgerichte?)\b/i,

  // Asian and South Asian main formats.
  /\b(?:curr(?:y|ies)|stir[\s-]?fr(?:y|ies)|wok|noodles?|fried rice|rice (?:dishes?|bowls?|plates?|tables?)|ramen|udon|soba|pho|laksa|biryani|thalis?|tandoor(?:i)?|bibimbap|chowmein|thukpa|sushi|sashimi)\b/i,
  /^\s*rice\s*$/i,

  // Italian and broadly European main formats.
  /\b(?:pasta|risotto|pizzas?|secondi|grills?|barbecue|bbq|roasts?|pies?)\b/i,

  // Protein-led headings. These help mixed menus whose sections are named for
  // the centre of the plate rather than the course (for example "Fish" or
  // "From the Grill"). Only vegetarian candidates inside them are considered.
  /^(?:steaks?|meats?|fish|seafood|chicken|poultry|beef|lamb|pork)$/i,
  /^(?:meats?|fish|seafood)(?:\s*(?:&|and|\/)\s*(?:meats?|fish|seafood))+$/i,
  /\b(?:steaks?|meats?|fish|seafood|chicken|poultry|beef|lamb|pork) (?:dishes|selection|specials?)\b/i,
  /\b(?:from|on) the (?:grill|sea|shell|land)\b/i,
  /\bfish\s*(?:&|\+|and)\s*chips\b/i,

  // Some menus collect their meat-free mains under a dietary heading rather
  // than repeating the cuisine format (for example "Veggies - Shakahari").
  /^(?:vegetarian|vegan|veggie|veggies)(?:\s*(?:\/|&|and|-)\s*(?:vegetarian|vegan|veggie|veggies|shakahari))?(?:\s+(?:dishes|options?))?$/i,
  /\bvegetarian dishes?\b/i,

  // Common full-meal formats on American, Mexican and café menus.
  /\b(?:burgers?|sandwiches?|tacos?|tostadas?|burritos?|quesadillas?|kebabs?)\b/i,
];

// Explicitly smaller courses. They remain valid fallbacks when a restaurant
// has no main-like section; they simply do not displace a known main because
// they happen to carry a price while that main does not.
const SMALL_SECTION_RE =
  /\b(?:starters?|appeti[sz]ers?|little dishes?|small(?:er)? (?:plates?|bites?)|bar bites?|snacks?|nibbles?|sides?|side orders?|accompaniments?|extras?|supplements?|desserts?|sweets?|puddings?|breads?|bakery|pastries|salads?|soups?|dips?|sauces?|condiments?)\b/i;

function highlightSectionPriority(name: string): number {
  // An explicit course label wins in compound headings such as "Vegetarian
  // Mains". Otherwise accompaniment language wins over a format keyword, so
  // "Rice & Breads" is not mistaken for the same course as "Rice Bowls".
  if (EXPLICIT_MAIN_SECTION_RE.test(name)) return 0;
  if (SMALL_SECTION_RE.test(name)) return 2;
  if (CUISINE_MAIN_SECTION_PATTERNS.some((pattern) => pattern.test(name))) return 0;
  return 1;
}

const SHARED_PRICE_CATEGORIES = [
  /\bcurr(?:y|ies)\b/i,
  /\bstir[\s-]?fr(?:y|ies)\b/i,
  /\bnoodles?\b/i,
  /\brice(?:\s+dishes?)?\b/i,
];

/**
 * Recover a shared choice-price ladder for an unpriced main section.
 *
 * Existing Baan Thai rows already say "Customizable protein option for
 * Curries, Stir Fries, Noodles & Rice", but the old extractor stored the
 * €20.95–€27.95 prices on those option rows instead of their real dishes. We
 * use that explicit description as the join: no description naming the target
 * section means no inferred price.
 */
function sharedModifierPriceForSection(sections: MenuSection[], sectionName: string): string | null {
  if (highlightSectionPriority(sectionName) !== 0) return null;
  const matchingCategories = SHARED_PRICE_CATEGORIES.filter((pattern) => pattern.test(sectionName));
  if (matchingCategories.length === 0) return null;

  const prices: number[] = [];
  let explicitlyApplies = false;
  for (const section of sections) {
    const modifiers = modifierDishes(section);
    modifiers.forEach((dish) => {
      const description = dish.description ?? '';
      if (!matchingCategories.some((pattern) => pattern.test(description))) return;
      explicitlyApplies = true;
      const price = parsePrice(dish.price);
      if (price !== null && price > 0) prices.push(price);
    });
  }
  if (!explicitlyApplies || prices.length < 2) return null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const number = (value: number) => String(Number(value.toFixed(2)));
  return min === max ? number(min) : `${number(min)}–${number(max)}`;
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

  const totalDishes = restaurant.sections.reduce((total, section) => {
    const modifiers = modifierDishes(section);
    return total + liveDishes(section).filter((dish) => !modifiers.has(dish)).length;
  }, 0);

  // Highlights: a few standout veg dishes, de-duped by normalized name so the
  // same dish on several menus counts once. A human reads the section first:
  // curries, stir-fries and noodles are mains whether or not each row repeats a
  // price. Price sorts within that semantic tier; when main prices tie, prefer
  // different sections so the card can showcase the breadth of the menu rather
  // than three adjacent curries.
  const seen = new Set<string>();
  type Candidate = {
    name: string;
    price: number | null;
    displayPrice: string | null;
    sectionName: string;
    sectionPriority: number;
    order: number;
  };
  const candidates: Candidate[] = [];
  let candidateOrder = 0;
  for (const section of restaurant.sections) {
    const modifiers = modifierDishes(section);
    const inheritedPrice = sharedModifierPriceForSection(restaurant.sections, section.name);
    for (const dish of liveDishes(section)) {
      if (modifiers.has(dish)) continue;
      // Counted dishes only — a card must never headline a naan or a sorbet.
      if (!isCountedVeg(section.name, dish)) continue;
      const key = normalizeDishName(dish.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const effectivePrice = dish.price ?? inheritedPrice;
      candidates.push({
        name: dish.name.trim(),
        price: parsePrice(effectivePrice),
        displayPrice: formatPrice(effectivePrice),
        sectionName: section.name,
        sectionPriority: highlightSectionPriority(section.name),
        order: candidateOrder++,
      });
    }
  }

  const ranked = candidates.sort(
    (a, b) =>
      Number(a.sectionPriority !== 0) - Number(b.sectionPriority !== 0) ||
      Number(b.price !== null) - Number(a.price !== null) ||
      (b.price ?? 0) - (a.price ?? 0) ||
      a.order - b.order
  );

  const topHighlights: Candidate[] = [];
  const selected = new Set<Candidate>();
  const representedSections = new Set<string>();
  while (topHighlights.length < MAX_HIGHLIGHTS) {
    const first = ranked.find((candidate) => !selected.has(candidate));
    if (!first) break;

    // Section breadth is only a tiebreak. It gives Baan Thai one curry, one
    // stir-fry and one noodle/rice dish because all share the same price range,
    // without replacing a €16.95 noodle elsewhere with a €12.45 one merely to
    // reach another section.
    const tied = ranked.filter((candidate) =>
      !selected.has(candidate) &&
      (candidate.sectionPriority === 0) === (first.sectionPriority === 0) &&
      candidate.price === first.price
    );
    const candidate = first.sectionPriority === 0
      ? (tied.find((item) => !representedSections.has(item.sectionName.toLowerCase().trim())) ?? first)
      : first;
    selected.add(candidate);
    representedSections.add(candidate.sectionName.toLowerCase().trim());
    topHighlights.push(candidate);
  }
  const highlights: HighlightDish[] = topHighlights.map((h) => ({ name: h.name, price: h.displayPrice }));
  const highlightsAreThin =
    highlights.length < MAX_HIGHLIGHTS || topHighlights.every((h) => isNonMainSectionName(h.sectionName));

  return { maxVegOptions, asideCount, bestMenu, perMenu, totalDishes, highlights, highlightsAreThin };
}
