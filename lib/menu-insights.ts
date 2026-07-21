import type { Restaurant, MenuSection, Dish } from '@/types';

// Guide-facing menu insights — all derived from data we already have, NO LLM.
//
// The key idea: a diner only sees ONE menu per visit, so a restaurant that sums
// 44 veg dishes across breakfast/lunch/dinner really offers ~11 at any sitting.
// We therefore rank and headline by the BEST SINGLE MENU's veg count, and show
// the per-menu breakdown. Side dishes are counted like any other veg option
// (no exclusion). Mains are only used to highlight a few example dishes.

/** True if a section name reads as a "main course" section — used ONLY to pick
 *  a few example mains to highlight. Pure string heuristic. */
export function isMainSection(name: string): boolean {
  const n = (name ?? '').toLowerCase();
  // Exclude sections that are clearly not mains even if they contain "main".
  if (/\b(side|starter|appetiz|dessert|sweet|small plate|pudding)/.test(n)) return false;
  return /\b(mains?|entrees?|entrées?|large plates?|from the grill|secondi|plats)\b/.test(n);
}

function isVeg(dish: Dish): boolean {
  return dish.classification === 'vegan' || dish.classification === 'vegetarian';
}

/** Collapse a dish name to a comparison key: drop parentheticals and standalone
 *  veg markers (V / VG / vegan…) so the same dish across menus dedupes to one. */
function normalizeMainName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(v|vg|ve|vgn|vegan|vegetarian|veg)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

/** Live (non-deleted) dishes of a section. */
function liveDishes(section: MenuSection): Dish[] {
  return section.dishes.filter((d) => !d.deletedAt);
}

export interface PerMenuVeg {
  /** Source-menu label (Lunch/Dinner/...); null for a single-menu restaurant. */
  label: string | null;
  /** All veg (vegan + vegetarian) dishes in this menu, sides included. */
  vegOptions: number;
}

export interface GuideInsights {
  /** Best single menu's veg count — the guide headline + ranking key. */
  maxVegOptions: number;
  /** Veg options per source menu, in display order. */
  perMenu: PerMenuVeg[];
  /** All live dishes across every menu (sides included). */
  totalDishes: number;
  /** Up to 3 example veg dishes from main-course sections (names). */
  vegMains: string[];
}

const MAX_VEG_MAINS = 3;

/** Compute the guide card's numbers from a restaurant's sections. Groups by
 *  menuLabel so multi-menu restaurants (Lunch/Dinner) report per menu and are
 *  ranked by their best single menu, not the sum. */
export function guideInsights(restaurant: Pick<Restaurant, 'sections'>): GuideInsights {
  // Group sections by menuLabel, preserving first-seen order (sections arrive
  // ordered by display_order). null label => a single "Menu" group.
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

  const perMenu: PerMenuVeg[] = order.map((label) => {
    const dishes = byLabel.get(label)!.flatMap(liveDishes);
    return { label, vegOptions: dishes.filter(isVeg).length };
  });

  const maxVegOptions = perMenu.reduce((max, m) => Math.max(max, m.vegOptions), 0);
  const totalDishes = restaurant.sections.flatMap(liveDishes).length;

  // Example mains: veg dishes living in a main-course section, de-duplicated by
  // a normalized name so the SAME dish appearing on several menus (e.g.
  // "Pappardelle", "Pappardelle (V)", "Pappardelle V") counts once.
  const seen = new Set<string>();
  const vegMains: string[] = [];
  for (const section of restaurant.sections) {
    if (!isMainSection(section.name)) continue;
    for (const dish of liveDishes(section)) {
      if (!isVeg(dish)) continue;
      const key = normalizeMainName(dish.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      vegMains.push(dish.name.trim());
      if (vegMains.length >= MAX_VEG_MAINS) break;
    }
    if (vegMains.length >= MAX_VEG_MAINS) break;
  }

  return { maxVegOptions, perMenu, totalDishes, vegMains };
}
