import type { Dish } from '@/types';

// What a dish IS, as far as a hungry vegetarian is concerned — no LLM, pure
// string heuristics (same spirit as menuAsDishReason in lib/review-flags.ts).
//
// Why this exists: the guide card's "N veggie" number used to count every dish
// the AI labelled vegan/vegetarian, so curry sauce, mayo, a side of chips and a
// cheesecake all inflated it. Shouk showed 40 veggie options, nine of which were
// €3 "Extra Tahini" top-ups. The same number sorts the whole guide, so
// restaurants were ranking by how many desserts and naans they serve.
//
// TWO RULES GOVERN EVERYTHING BELOW, and both exist because of real dishes in
// the live guides:
//
// 1. Match on DISH names, not section names (desserts and dedicated sauce
//    sections excepted). Indian restaurants file their vegetarian mains under
//    "Sides" / "Accompaniments" / "Condiments/Sides" — Palak Paneer, Bhindi
//    Masala, Ghar Ki Dal. A section-name rule would delete exactly the dishes a
//    vegetarian came for.
// 2. A keyword only fires on a SIMPLE name (see isSimpleName). "Bread & Butter"
//    is bread; "48-hour Sourdough, Parmesan Custard, Cep Butter" is a €7
//    composed starter. Same keyword, opposite answers, and length is what tells
//    them apart.
//
// When in doubt we COUNT the dish. Over-counting slightly is acceptable;
// under-counting makes a good restaurant look hostile to vegetarians, which is
// the worse failure. Every excluded dish is still shown on the menu — this
// decides what goes in the headline number, never what a diner gets to see.

export type DishRole = 'counted' | 'dessert' | 'condiment' | 'staple';

export interface DishRoleVerdict {
  role: DishRole;
  /** Which rule matched, for the audit report. Null when the dish is counted. */
  rule: string | null;
  /**
   * The name alone cannot settle this one; PRICE decides (see makePriceTest in
   * lib/menu-insights). Cheap relative to the menu → not a real dish; at or
   * above that line → a real dish. `role` is the answer when there is no price
   * to go on.
   *
   * It cuts both ways: a bar-snack-section dish is counted unless it's cheap,
   * while a "… sauce" is a condiment unless it's dear (Baan Thai's €26.50
   * "Tamarind Sauce" is a main course).
   *
   * Kept deliberately RARE. Price is dangerous here: at Pickle the veg curries
   * run €8.50–€14.50 against €38 mains, so a broad price rule would delete
   * exactly the dishes this feature exists to protect. Only a bar-snack section
   * earns the flag, never "Sides" or "Accompaniments".
   */
  ambiguous?: boolean;
}

const COUNTED: DishRoleVerdict = { role: 'counted', rule: null };

// Sections that are explicitly a bar-nibble context — where a cheap item really
// is a nibble and not the vegetarian offering. Anchored to the whole section
// name so "Snacks & Extras" or "Bar Bites" qualify but "Sides" never does.
// "Tapas"/"Raciones"/"Sharing" are excluded on purpose: at those restaurants
// the small plates ARE the meal.
const NIBBLE_SECTION_RE =
  /^(nibbles?|snacks?|bites?|bar\s+(snacks?|bites?)|para\s+picar|pinxtos?|pintxos?|aperitivos?)(\s*[&+/]\s*\w+)?$/i;

/** Lowercase, drop parentheticals, fold accents, collapse whitespace. Folding
 *  accents means the keyword lists below are written unaccented once and still
 *  match "Béarnaise", "crème brûlée", "Padrón". */
function normalize(text: string): string {
  return (text ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFD')
    // The combining-diacritics block, rather than \p{Diacritic}: the unicode
    // property escape needs an es6 target, and this project compiles lower.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(normalized: string): number {
  return normalized.split(/\s+/).filter(Boolean).length;
}

/** Components of a dish name — the things joined by commas, ampersands or
 *  "and"/"with". A real composed dish lists what is on the plate. */
function components(normalized: string): string[] {
  return normalized
    .split(/[,&+/]|\bwith\b|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The thing actually being sold. "Chips with mayo" is chips; "Truffle mayo" is
 *  mayo. Condiment and staple keywords are tested against this alone, so a
 *  sauce named as an accompaniment can't disqualify the dish it comes with —
 *  which is what wrongly excluded a chip shop's entire menu. */
function headComponent(normalized: string): string {
  return components(normalized)[0] ?? normalized;
}

/**
 * The dish, minus any accompaniment introduced by "with" or "in".
 *
 * "Paneer tikka with butter naan" is paneer tikka; "Irish baby potatoes in herb
 * butter" is potatoes. Every head-final rule below reads THIS, not the raw
 * name, so an accompaniment can never be mistaken for the dish.
 */
function dishPart(normalized: string): string {
  return normalized.split(/\bwith\b|\bin\b/)[0].trim() || normalized;
}

function accompaniment(normalized: string): string {
  const parts = normalized.split(/\bwith\b|\bin\b/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
}

/** The guard that keeps keyword matching honest. A staple or condiment is named
 *  in a few words ("Bread & Butter", "Butter Naan", "Basmati Rice"); a dish that
 *  merely CONTAINS one is longer and lists its components ("48-hour Sourdough,
 *  Parmesan Custard, Cep Butter"). Anything above the threshold gets counted. */
export function isSimpleName(name: string): boolean {
  const n = normalize(name);
  return components(n).length <= 3 && wordCount(n) <= 5;
}

function includesAny(normalized: string, keywords: string[]): string | null {
  for (const k of keywords) {
    if (normalized.includes(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------- desserts

// Section names that are unambiguously the sweet course. "sweets" is plural on
// purpose: a bare \bsweet\b would swallow a "Sweet & Sour" section.
// "something sweet" / "to finish" / "afters" are here because Drury Buildings
// files its puddings under "Something Sweet" — two ice-cream tarts were being
// counted as veggie options purely because the section wasn't spelled
// "Desserts". A bare \bsweet\b would swallow a "Sweet & Sour" section, hence
// the exact phrases.
const DESSERT_SECTION_RE =
  /\bdesserts?\b|\bsweets\b|\bpuddings?\b|\bdolci\b|\bnagerecht|\bpostres?\b|\bpatisserie\b|\bsomething sweet\b|\bsweet treats?\b|^to finish$|^afters$/i;

// Dish names that are desserts wherever they appear. Deliberately excludes bare
// "cake" (fish cake, rice cake) and "tart" (tomato tart) — both are savoury
// often enough that the "when in doubt, count it" rule says leave them.
const DESSERT_DISH_KEYWORDS = [
  'cheesecake', 'ice cream', 'sorbet', 'gelato', 'panna cotta', 'tiramisu',
  'baklawa', 'baklava', 'gulab jamun', 'kulfi', 'posset', 'brownie', 'affogato',
  'creme brulee', 'cannolo', 'cannoli', 'semifreddo', 'pavlova',
  'parfait', 'sticky toffee', 'kheer', 'malabi', 'profiterole', 'macaron',
];
// Deliberately NOT here: "mousse" (Glas serves an Artichoke Mousse as a
// starter), "cake" (fish cake, rice cake) and "tart" (tomato tart). Each is
// savoury often enough that the when-in-doubt-count rule wins. Anything in an
// actual dessert section is caught by DESSERT_SECTION_RE regardless.

// ------------------------------------------------------- condiments & sauces

// A section that is ONLY sauces, dips or build-your-own components. Anchored
// and exact on purpose: "Dips" and "House Sauces" qualify, but "Condiments/
// Sides" (which holds Pickle's Palak Paneer and Bhindi Masala) and "Dips &
// Pita" (Shouk's actual meal, €7.50) must not. Nor does a bare "Extras" —
// Fade Street Social files a €21.50 Truffle Cheese Flatbread there.
//
// This rule exists because plenty of components carry no keyword at all:
// "Brandy Peppercorn", "Roast Garlic & Herb", and Fabel Friet's €0.10 "Chopped
// onions" and €1.95 "Cheddar". Only the section name gives those away — a
// "Create Your Own" list is toppings, not a menu of dishes.
const CONDIMENT_SECTION_RE =
  /^(house\s+|extra\s+)?(sauces?|dips?|condiments?)$|^(create|build|make)\s+your\s+own$|^toppings?$|^add[-\s]?ons?$/i;

const CONDIMENT_KEYWORDS = [
  'mayo', 'mayonnaise', 'aioli', 'ketchup', 'bearnaise', 'chimichurri',
  'chilli oil', 'chili oil', 'gravy', 'chutney', 'raita', 'vinaigrette',
  'zhug', 'amba', 'harissa', 'pesto dip',
];

// ------------------------------------------------------------------ staples

const STAPLE_KEYWORDS = [
  // plain rice
  'white rice', 'basmati rice', 'steamed rice', 'plain rice', 'pulao rice',
  'house rice', 'boiled rice',
  // breads
  'naan', 'roti', 'paratha', 'parantha', 'chapati', 'papadum', 'poppadom',
  'bread & butter', 'bread and butter', 'bread + butter', 'bread basket',
  'breadbasket', 'sourdough', 'focaccia', 'foccacia', 'crackers',
  // pita ONLY as an add-on: "Hummus & Pita" (€7.50) and "Cauliflower Pita"
  // (€10) are meals at a Middle Eastern restaurant, not bread.
  'extra pita', 'fried pita bites', 'pita bites',
  // Bar staples, matched on the NOUN rather than an adjective phrase. The list
  // used to say "smoked almonds", which is what Dublin menus happen to write —
  // so Uno Mas's "Salted almonds" sailed through. A keyword list of observed
  // phrases only ever catches the wording it has already seen; the noun
  // generalises, and the simple-name guard is what stops it over-firing on
  // "Roast Carrots, Pesto, Almond & Cumin".
  'olives', 'almond', 'chips', 'fries',
];

/** Bare "rice"/"bread" as the entire dish name. */
const BARE_STAPLE_RE = /^(rice|bread|pita|naan|chips|fries|olives)$/;

/** Potato as the ENTIRE dish name. Unlike the staples above this is matched
 *  against the whole name, never the head component: "Potato & leek soup" has
 *  the head "potato" and is very much a dish. */
const BARE_POTATO_RE = /^(potatoes?|mash|mashed potatoes?)$/;

// ------------------------------------------------------- head-FINAL staples
//
// Everything above reads the HEAD of the name, because English dish names are
// usually head-initial: "Chips with mayo" is chips. But a modifier list is
// head-FINAL — "Garlic, Onion and Coriander Naan" is a naan, and reading its
// head gives "garlic". We were only ever looking at one end of the name, which
// is why Rasam's every-other-naan was excluded while that one was counted.
//
// The rules below read the far end. Each is deliberately narrow: a tail rule is
// riskier than a head rule, because the last word of a composed dish name is
// often its garnish ("Fried eggs on bread", "Hummus & Pita" — both real meals).

/** Tandoori breads. Nobody sells "X Naan" as a main course, so this one needs
 *  no price or length guard — only the with/in split (so "Paneer tikka with
 *  butter naan" stays a paneer tikka). */
const TANDOOR_BREAD_TAIL_RE = /\b(naans?|nan|rotis?|parathas?|paranthas?|chapatis?|papadums?|poppadoms?)$/;

/** Ordinary breads. NOT safe on their own: Fade Street's €20.50 "Truffle Cheese
 *  Flatbread" is a pizza and Winkel 43's €8 "Fried eggs on bread" is breakfast,
 *  while Shouk's €3.00 "Gluten Free Bread" is bread. Price is what separates
 *  them, so this returns `ambiguous` and lets the caller decide. */
const BREAD_TAIL_RE = /\b(breads?|flatbreads?|sourdough|focaccias?|foccacia|toast)$/;

/** Bread and butter, however it's dressed up — The Pig's Ear's €6.50 "Guinness
 *  Bread & Butter" (the head rule reads that as "guinness bread") and
 *  Featherblade's €5.50 "Warm Focaccia & Whipped Smoked Butter".
 *
 *  `[^,]*` is load-bearing: it stops the match crossing a comma, so Mr Fox's
 *  "48-hour Sourdough, Parmesan Custard, Cep Butter" stays the €7 starter it
 *  is rather than being read as bread with butter. */
const BREAD_AND_BUTTER_RE = /\b(breads?|sourdough|focaccias?|foccacia|toast)\b[^,]*(?:and|&|\+|with)[^,]*\bbutter\b/;

/**
 * A potato side: potato is the only thing on the plate.
 *
 * Founder's rule (2026-08-05): "any side of potatoes if potatoes is the only
 * main ingredient — roast potatoes, fries, mashed potatoes". Measured across
 * both live guides this is the single biggest gap, 20 dish rows at 13
 * restaurants (SOLE's "Creamed potatoes" and "Irish baby potatoes in herb
 * butter", Fade Street's "Glazed New Potatoes", Old Street's "Chive & Butter
 * Sautéed Baby Potatoes", Uno Mas, Kicky's, Bar Pez, Etto, Ananda…).
 *
 * Two guards keep it off real dishes:
 *   - The potato component must be 2–4 words. "Potato & leek soup" has a
 *     one-word "potato" component and a "leek soup" one, so it survives; so do
 *     "Potato Gnocchi" and "Patatas Bravas" (potato isn't the last word).
 *   - If the name carries a "with/in …" clause, that clause must be a SAUCE.
 *     "Roast potatoes with garlic mayo" is a side; "Baked potato with beans and
 *     cheese" is lunch, and the difference is entirely in what follows "with".
 */
const POTATO_TAIL_RE = /\b(potato|potatoes|mash|fries|chips)$/;
const SAUCE_TRAILER_RE =
  /\b(butter|mayo|mayonnaise|aioli|oils?|sauces?|creams?|gravy|dressing|vinaigrette|salt|herbs?|rosemary|thyme|truffle|garlic|parsley|chives?|skins?)\b/;

/** A modified staple with nothing else on the plate — "Creamed potatoes",
 *  "Truffle & parmesan fries". The staple may lead or trail the name, but
 *  everything else in it must be a seasoning: "Roast potatoes, chard &
 *  romesco" names two other vegetables, so it stays a dish. */
function isSoloStaple(name: string, tailRe: RegExp): boolean {
  const extra = accompaniment(name);
  // Potatoes plus a sauce is a side; potatoes plus real food is lunch.
  if (extra && !SAUCE_TRAILER_RE.test(extra)) return false;

  const parts = components(dishPart(name));
  const isStaple = (c: string) => wordCount(c) >= 2 && wordCount(c) <= 4 && tailRe.test(c);
  const at = isStaple(parts[0]) ? 0 : isStaple(parts[parts.length - 1]) ? parts.length - 1 : -1;
  if (at === -1) return false;
  return parts.every((c, i) => i === at || SAUCE_TRAILER_RE.test(c));
}

/** A staple named head-finally, where the rest of the name only modifies it —
 *  "Garlic, Onion and Coriander Naan". Reads the LAST component only: a dish
 *  that merely ends with a bread is usually served on one ("48-hour Sourdough,
 *  Parmesan Custard, Cep Butter" ends in butter and is a €7 starter). */
function endsInStaple(name: string, tailRe: RegExp): boolean {
  const parts = components(dishPart(name));
  const last = parts[parts.length - 1] ?? '';
  return wordCount(last) >= 2 && tailRe.test(last);
}

/**
 * Marks an add-on rather than a dish in its own right — the café pattern of
 * "add avocado", "+ fried egg", "side of strawberries". A topping is never a
 * dish however tempting it is; these belong in the sides tally.
 *
 * Kept to leading position so it can't fire on a real dish that merely
 * contains the word (a "Cheddar and onion toastie" is not an add-on).
 */
const ADDON_PREFIX_RE = /^(\+|extra|side of|add|add[-\s]?on|additional|topping)\b/;

/**
 * What role a dish plays on the menu. Only `'counted'` feeds the headline
 * "N veggie" figure; everything else is shown but tallied separately.
 *
 * @param sectionName the dish's menu section ("Desserts", "Condiments/Sides")
 */
export function classifyDishRole(
  sectionName: string | null | undefined,
  dish: Pick<Dish, 'name'>
): DishRoleVerdict {
  const section = normalize(sectionName ?? '');
  const name = normalize(dish.name ?? '');
  if (!name) return COUNTED;

  // A dessert section is a dessert section regardless of how elaborate the
  // dish name is — "Burnt Basque Cheesecake, Caramelised Banana" is still pud.
  if (DESSERT_SECTION_RE.test(section)) return { role: 'dessert', rule: 'dessert section' };
  if (CONDIMENT_SECTION_RE.test(section)) return { role: 'condiment', rule: 'sauce/dip section' };

  // Head-FINAL staples run BEFORE the simple-name guard, because the modifiers
  // are what make these names long in the first place: "Chive & Butter Sautéed
  // Baby Potatoes" is six words and still just potatoes. They carry their own
  // guards (see isSoloStaple / endsInStaple) instead.
  if (BARE_POTATO_RE.test(name) || isSoloStaple(name, POTATO_TAIL_RE)) {
    return { role: 'staple', rule: 'potatoes on their own' };
  }
  if (endsInStaple(name, TANDOOR_BREAD_TAIL_RE)) return { role: 'staple', rule: 'named "… naan/roti"' };
  if (BREAD_AND_BUTTER_RE.test(name)) return { role: 'staple', rule: 'bread & butter' };
  // Bread alone can't settle it — a €3 "Gluten Free Bread" and a €20.50
  // "Truffle Cheese Flatbread" have the same shape. Price decides.
  if (endsInStaple(name, BREAD_TAIL_RE)) {
    return { role: 'staple', rule: 'named "… bread"', ambiguous: true };
  }

  // Everything below is dish-name matching, and must clear the simple-name
  // guard so composed dishes survive. Allta's "Braised kombu, salted milk ice
  // cream, bergamot" is a savoury tapa, not an ice cream.
  if (!isSimpleName(name)) return COUNTED;

  const dessert = includesAny(name, DESSERT_DISH_KEYWORDS);
  if (dessert) return { role: 'dessert', rule: `dish name: "${dessert}"` };

  if (ADDON_PREFIX_RE.test(name)) return { role: 'condiment', rule: 'add-on ("extra…"/"side of…")' };

  // Condiments and staples are judged on the HEAD of the name only. "Chips with
  // mayo" and "Chips, Parmesan & truffle mayo" are chips — matching "mayo"
  // anywhere in the string excluded a whole chip shop's menu.
  const head = headComponent(name);

  const condiment = includesAny(head, CONDIMENT_KEYWORDS);
  if (condiment) return { role: 'condiment', rule: `named "${condiment}"` };

  // A dish whose whole name ENDS in "sauce", in four words or fewer. This one
  // reads the full name rather than the head, because a sauce is often named
  // for its ingredients ("Tomato & coriander sauce" — head "tomato").
  //
  // Marked ambiguous because a Thai kitchen names MAIN COURSES this way: Baan
  // Thai sells "Tamarind Sauce" and "Choo Chee Sauce" at €26.50. Price settles
  // it — a €2.75 pot of sauce is a condiment, a €26.50 one is dinner.
  if (/\bsauces?$/.test(name) && wordCount(name) <= 4) {
    return { role: 'condiment', rule: 'named "… sauce"', ambiguous: true };
  }

  if (BARE_STAPLE_RE.test(head)) return { role: 'staple', rule: `bare "${head}"` };

  const staple = includesAny(head, STAPLE_KEYWORDS);
  if (staple) return { role: 'staple', rule: `named "${staple}"` };

  // Nothing in the name settles it, and we're in a bar-snack section. Counted
  // for now; the caller may demote it on price.
  if (NIBBLE_SECTION_RE.test(section)) return { role: 'counted', rule: null, ambiguous: true };

  return COUNTED;
}

/** Whether a dish belongs in the headline "N veggie" figure. */
export function isCountedDish(sectionName: string | null | undefined, dish: Pick<Dish, 'name'>): boolean {
  return classifyDishRole(sectionName, dish).role === 'counted';
}

/** Human label for the aside bucket, used in the card's small print and the
 *  audit report. */
export const ASIDE_LABEL = 'sides & sweets';
