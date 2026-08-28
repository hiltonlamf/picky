/**
 * Detect price/variation rows that describe how to order a dish, rather than
 * food dishes in their own right.
 *
 * Thai and other Asian menus often print one shared protein price ladder next
 * to a group of curries or stir-fries. An extractor can otherwise turn
 * "Chicken / Beef / Tofu / Vegetable" into four dishes. Keep this deliberately
 * conservative: an isolated "Mushroom" can be a real pizza, so bare ingredient
 * names are removed only when several occur together beside real described
 * dishes, or when the whole section explicitly identifies itself as choices.
 */

interface MenuItemLike {
  name: string;
  description?: string | null;
  deletedAt?: string | null;
}

interface MenuSectionLike<T extends MenuItemLike = MenuItemLike> {
  name: string;
  dishes: T[];
}

const MODIFIER_SECTION_RE =
  /^(?:(?:choose|pick|select)(?:\s+(?:your|a))?\s+(?:protein|main ingredients?)|choices?\s+of\s+(?:protein|main ingredients?)|(?:protein|main ingredients?)\s+(?:choices?|options?|customi[sz]ation(?:\s+options?)?))$/i;

const BARE_CHOICE_RE =
  /^(?:chicken|beef|pork|duck|lamb|tofu|tempeh|seitan|paneer|vegetables?|mixed\s+vegetables?|seasonal\s+vegetables?|mushrooms?|prawns?|jumbo\s+prawns?|shrimps?|mussels?|fish|sea\s+bass|salmon|egg)$/i;

const MIN_BARE_CHOICES = 3;

function normalize(name: string): string {
  return (name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Section names that unambiguously describe choices, not dishes. */
export function isModifierSectionName(name: string | null | undefined): boolean {
  return MODIFIER_SECTION_RE.test(normalize(name ?? ''));
}

function isBareChoice(dish: MenuItemLike): boolean {
  return !dish.deletedAt && BARE_CHOICE_RE.test(normalize(dish.name));
}

/**
 * The rows to suppress from a section. The returned set contains the original
 * objects, so callers do not have to identify rows by a potentially duplicated
 * name or database id.
 */
export function modifierDishes<T extends MenuItemLike>(section: MenuSectionLike<T>): Set<T> {
  if (isModifierSectionName(section.name)) return new Set(section.dishes);

  const candidates = section.dishes.filter(isBareChoice);
  if (candidates.length < MIN_BARE_CHOICES) return new Set<T>();

  // A mixed section provides the structural evidence: several bare choices
  // sit beside at least one actual, described dish. This catches Baan Thai's
  // soup variations without blacklisting real menu items named "Mushroom".
  const hasDescribedDish = section.dishes.some(
    (dish) => !dish.deletedAt && !isBareChoice(dish) && Boolean(dish.description?.trim())
  );
  if (!hasDescribedDish) return new Set<T>();

  return new Set(candidates);
}
