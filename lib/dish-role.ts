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
}

const COUNTED: DishRoleVerdict = { role: 'counted', rule: null };

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
const DESSERT_SECTION_RE =
  /\bdesserts?\b|\bsweets\b|\bpuddings?\b|\bdolci\b|\bnagerecht|\bpostres?\b|\bpatisserie\b/i;

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

// A section that is ONLY sauces/dips. Anchored and exact on purpose: "Dips" and
// "House Sauces" qualify, but "Condiments/Sides" (which holds Pickle's Palak
// Paneer and Bhindi Masala) and "Dips & Pita" (Shouk's actual meal, €7.50)
// must not. This rule exists because "Brandy Peppercorn" and "Roast Garlic &
// Herb" contain no keyword at all — only their section gives them away.
const CONDIMENT_SECTION_RE = /^(house\s+|extra\s+)?(sauces?|dips?|condiments?)$/i;

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
  // bar staples
  'olives', 'smoked almonds', 'chips', 'fries',
];

/** Bare "rice"/"bread" as the entire dish name. */
const BARE_STAPLE_RE = /^(rice|bread|pita|naan|chips|fries|olives)$/;

/** Prefixes that mark an add-on rather than a dish in its own right. */
const ADDON_PREFIX_RE = /^(extra|side of|add|additional)\b/;

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

  // A dish CALLED a sauce, in four words or fewer. The word limit protects
  // Etto's "Padron pepper and romesco sauce" (€12, a real tapa) while still
  // catching "Mint sauce" and "Tomato & coriander sauce" (€2.75 each).
  if (/\bsauces?$/.test(head) && wordCount(head) <= 4) {
    return { role: 'condiment', rule: 'named "… sauce"' };
  }

  if (BARE_STAPLE_RE.test(head)) return { role: 'staple', rule: `bare "${head}"` };

  const staple = includesAny(head, STAPLE_KEYWORDS);
  if (staple) return { role: 'staple', rule: `named "${staple}"` };

  return COUNTED;
}

/** Whether a dish belongs in the headline "N veggie" figure. */
export function isCountedDish(sectionName: string | null | undefined, dish: Pick<Dish, 'name'>): boolean {
  return classifyDishRole(sectionName, dish).role === 'counted';
}

/** Human label for the aside bucket, used in the card's small print and the
 *  audit report. */
export const ASIDE_LABEL = 'sides & sweets';
