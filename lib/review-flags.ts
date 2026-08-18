import type { Restaurant, Dish } from '@/types';

// The public Dublin Guide only shows restaurants with at least this many real
// dishes. Fewer than this almost always means the pipeline mis-read the site
// (e.g. captured a tasting menu as one "dish", or grabbed a fragment), so the
// restaurant is withheld and surfaced for review instead of shown to diners.
export const MIN_GUIDE_DISHES = 7;

/**
 * The same test, applied to each menu individually.
 *
 * MIN_GUIDE_DISHES is a per-RESTAURANT total, so a restaurant can clear it
 * comfortably while carrying a broken menu inside it — and the picker shows
 * that broken menu to diners as an equal option. Found in production:
 * Chapter One (13 dishes, live) had a "Dinner Menu" of 2, and Featherblade
 * had a whole menu called "Burgers" holding one item, "The Best Burger in
 * Dublin", which is a marketing headline rather than a dish.
 *
 * Lower than MIN_GUIDE_DISHES on purpose: the bar for a single menu has to sit
 * below the bar for a whole restaurant.
 */
export const MIN_MENU_DISHES = 5;

/**
 * Menu types that are genuinely short, and must not be flagged for it.
 *
 * A dessert menu of three or four is a normal dessert menu, not a broken
 * parse — Pickle (4) and Drury Buildings (3) both have one, and an earlier
 * version of this rule would have pulled both off the live guide for it.
 * Sides, sauces and cheese lists are short for the same honest reason.
 */
const LEGITIMATELY_SHORT_MENU_RE =
  /\b(dessert|desserts|sweet|sweets|pudding|puddings|side|sides|sauce|sauces|cheese|cheeses|extra|extras|nagerecht|dolci|postres)\b/i;

export type ReviewFlagCode = 'few_dishes' | 'menu_as_dish' | 'thin_menu' | 'duplicate_menu';

export interface ReviewFlag {
  code: ReviewFlagCode;
  /** Short label for admin chips. */
  label: string;
  /** One-line human explanation (may name the offending dish). */
  detail: string;
}

/** Live (non-deleted) dishes across all sections. Filters soft-deleted rows so
 *  this is correct even on the admin review screen, which fetches dishes with
 *  includeDeleted: true. */
export function liveDishes(restaurant: Pick<Restaurant, 'sections'>): Dish[] {
  return restaurant.sections.flatMap((s) => s.dishes).filter((d) => !d.deletedAt);
}

export function countDishes(restaurant: Pick<Restaurant, 'sections'>): number {
  return liveDishes(restaurant).length;
}

// Strong tells that a single "dish" is really a whole menu (a tasting/set menu,
// or a menu title like "Dim Sum Menu" captured as one item).
const MENU_KEYWORD_RE =
  /\b(tasting|set|sample|sampling|degustation|dégustation)\s+menu\b|\bmenu\s+du\s+jour\b|\bprix\s*fixe\b|\b\d+\s*courses?\b|\bdim\s*sum\s+menu\b/i;

// A dish name that is really a section/menu title, not a food item.
const MENU_TITLE_NAME_RE =
  /^(lunch|dinner|brunch|breakfast|tasting|set|sample|a\s*la\s*carte|à\s*la\s*carte|dim\s*sum|christmas|festive|early\s*bird|group|sharing|kids?|children'?s?|drinks?|wine|cocktails?)\s*(menu)?$/i;

function priceTokenCount(text: string): number {
  return (text.match(/(?:€|£|\$)\s?\d|\b\d{1,3}(?:\.\d{2})\b/g) ?? []).length;
}

/** Returns the reason a dish looks like a whole menu rather than a single dish,
 *  or null if it looks like a normal dish. Pure string heuristics — no AI. */
function menuAsDishReason(dish: Dish): string | null {
  const name = (dish.name ?? '').trim();
  const desc = (dish.description ?? '').trim();
  if (MENU_TITLE_NAME_RE.test(name)) return `"${name}" reads as a menu title, not a dish`;
  if (MENU_KEYWORD_RE.test(name) || MENU_KEYWORD_RE.test(desc)) return `"${name}" looks like a tasting/set menu`;
  // A very long description crammed with several prices/lines is a menu, not a dish.
  const bodyLooksLikeAMenu =
    desc.length > 250 && (priceTokenCount(desc) >= 3 || (desc.match(/\n/g)?.length ?? 0) >= 4);
  if (bodyLooksLikeAMenu) return `"${name}" has a menu-sized description (${desc.length} chars, multiple courses/prices)`;
  return null;
}

/**
 * How many OTHER live dishes share a menu with this one.
 *
 * Menus are identified by menuLabel; an untagged restaurant is one menu, so
 * every other dish counts. Used to tell a mis-read menu (the suspect row is
 * nearly all there is) from a real dish that merely reads like a menu title.
 */
function dishesSharingMenuWith(restaurant: Pick<Restaurant, 'sections'>, dish: Dish): number {
  const menuOf = (d: Dish): string | null =>
    restaurant.sections.find((s) => s.dishes.some((x) => x.id === d.id))?.menuLabel ?? null;
  const label = menuOf(dish);
  return restaurant.sections
    .filter((s) => (s.menuLabel ?? null) === label)
    .flatMap((s) => s.dishes)
    .filter((d) => !d.deletedAt && d.id !== dish.id).length;
}

/** All review flags for a restaurant. Empty = looks fine. Used both to gate
 *  public visibility and to build the admin "needs review" queue. */
export function computeReviewFlags(restaurant: Pick<Restaurant, 'sections'>): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const dishes = liveDishes(restaurant);

  if (dishes.length < MIN_GUIDE_DISHES) {
    flags.push({
      code: 'few_dishes',
      label: `Only ${dishes.length} dish${dishes.length === 1 ? '' : 'es'}`,
      detail: `Fewer than ${MIN_GUIDE_DISHES} dishes — often a sign the menu wasn't really read.`,
    });
  }

  // Only a menu that is MOSTLY the suspect row was really mis-read. A "Tasting
  // Menu" line sitting inside a properly-read menu is just a dish the
  // restaurant sells: Pickle lists a €95 "Tasting Menu — curated by Chef Sunil,
  // on request" among 44 à la carte dishes, and Hot Stone an "A5 Kobe Tasting
  // Menu" among 56. Both were withheld from the guide for correctly reading a
  // real item. A parse that found 44 dishes plainly did not collapse a menu
  // into one row, which is the failure this flag exists to catch.
  for (const dish of dishes) {
    const reason = menuAsDishReason(dish);
    if (!reason) continue;
    if (dishesSharingMenuWith(restaurant, dish) >= MIN_GUIDE_DISHES) continue;
    flags.push({ code: 'menu_as_dish', label: 'Menu-as-dish', detail: reason });
    break; // one is enough to warrant a look
  }

  for (const { label, count } of thinMenus(restaurant)) {
    flags.push({
      code: 'thin_menu',
      label: `"${label}" has ${count} dish${count === 1 ? '' : 'es'}`,
      detail:
        `The "${label}" menu holds only ${count} dish${count === 1 ? '' : 'es'} — ` +
        `too few to be a real menu, so it was probably read wrong.`,
    });
    break; // one is enough to warrant a look
  }

  for (const pair of duplicateMenus(restaurant)) {
    flags.push({
      code: 'duplicate_menu',
      label: `"${pair.a}" \u2248 "${pair.b}"`,
      detail:
        `"${pair.a}" and "${pair.b}" share ${pair.shared} of ${pair.smaller} dishes \u2014 ` +
        `probably one menu shown twice. Flagged for a human, never deleted automatically.`,
    });
    break; // one is enough to warrant a look
  }

  return flags;
}

/**
 * How alike two menus must be before a human should look at them.
 *
 * Founder's call (2026-08-18): a duplicate menu is ALWAYS flagged for review,
 * never removed automatically. Extraction is not deterministic \u2014 the same PDF
 * read twice yields 18, 19 or 20 dishes \u2014 so menus that are really one menu
 * often do not match exactly, and a rule that deleted near-matches would be
 * guessing. It would also be wrong: Blauw Amsterdam's "Amsterdam" and "Utrecht"
 * menus share 24 of 25 dishes and are two genuinely different branches.
 */
const DUPLICATE_OVERLAP = 0.9;

/** Menus of very different sizes are different menus however much they share:
 *  an 8-dish lunch inside a 20-dish a la carte is a real, smaller menu. */
const DUPLICATE_SIZE_RATIO = 0.7;

/** Below this, two menus sharing a dish list is coincidence, not duplication. */
const MIN_DUPLICATE_MENU_DISHES = 3;

/** Normalised live dish names per labelled menu. */
function dishNamesByMenu(restaurant: Pick<Restaurant, 'sections'>): Map<string, Set<string>> {
  const byMenu = new Map<string, Set<string>>();
  for (const section of restaurant.sections) {
    const label = section.menuLabel;
    if (!label) continue;
    if (!byMenu.has(label)) byMenu.set(label, new Set());
    const names = byMenu.get(label)!;
    for (const d of section.dishes) {
      if (d.deletedAt) continue;
      names.add((d.name ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim());
    }
  }
  return byMenu;
}

/**
 * Pairs of menus alike enough that they are probably one menu shown twice.
 * Reported, never removed.
 *
 * Exported so the admin queue and the QA preview can name BOTH menus rather
 * than just reporting that something is wrong.
 */
export function duplicateMenus(
  restaurant: Pick<Restaurant, 'sections'>
): Array<{ a: string; b: string; shared: number; smaller: number }> {
  const byMenu = Array.from(dishNamesByMenu(restaurant).entries());
  const pairs: Array<{ a: string; b: string; shared: number; smaller: number }> = [];
  for (let i = 0; i < byMenu.length; i++) {
    for (let j = i + 1; j < byMenu.length; j++) {
      const [labelA, namesA] = byMenu[i];
      const [labelB, namesB] = byMenu[j];
      const smaller = Math.min(namesA.size, namesB.size);
      const larger = Math.max(namesA.size, namesB.size);
      if (smaller < MIN_DUPLICATE_MENU_DISHES || larger === 0) continue;
      if (smaller / larger < DUPLICATE_SIZE_RATIO) continue;
      const shared = Array.from(namesA).filter((n) => namesB.has(n)).length;
      if (shared / smaller >= DUPLICATE_OVERLAP) pairs.push({ a: labelA, b: labelB, shared, smaller });
    }
  }
  return pairs;
}

/**
 * Menus that are individually too thin to be real. Only labelled menus are
 * checked: an untagged single menu is already covered by the whole-restaurant
 * MIN_GUIDE_DISHES test, and double-flagging it would say the same thing twice.
 *
 * Exported so the admin queue and the QA preview can name the offending menu
 * rather than just reporting that something is wrong.
 */
export function thinMenus(
  restaurant: Pick<Restaurant, 'sections'>
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const section of restaurant.sections) {
    const label = section.menuLabel;
    if (!label) continue;
    const live = section.dishes.filter((d) => !d.deletedAt).length;
    counts.set(label, (counts.get(label) ?? 0) + live);
  }
  return Array.from(counts.entries())
    .filter(([label, count]) => count < MIN_MENU_DISHES && !LEGITIMATELY_SHORT_MENU_RE.test(label))
    .map(([label, count]) => ({ label, count }));
}

/** Whether a restaurant may appear on the PUBLIC guide right now.
 *  Must be a completed analysis with enough dishes, and either clean of review
 *  flags OR explicitly approved by an admin (guideApprovedAt). */
export function isPubliclyVisible(
  restaurant: Pick<Restaurant, 'sections' | 'status' | 'guideApprovedAt'>
): boolean {
  if (restaurant.status !== 'done') return false;
  if (countDishes(restaurant) < MIN_GUIDE_DISHES) return false;
  if (restaurant.guideApprovedAt) return true;
  return computeReviewFlags(restaurant).length === 0;
}
