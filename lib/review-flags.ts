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

export type ReviewFlagCode = 'few_dishes' | 'menu_as_dish' | 'thin_menu';

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

  for (const dish of dishes) {
    const reason = menuAsDishReason(dish);
    if (reason) {
      flags.push({ code: 'menu_as_dish', label: 'Menu-as-dish', detail: reason });
      break; // one is enough to warrant a look
    }
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

  return flags;
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
