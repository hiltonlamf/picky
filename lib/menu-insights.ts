import type { Restaurant, MenuSection, Dish } from '@/types';

// Guide-facing menu insights — all derived from data we already have, NO LLM.
//
// A diner only sees ONE menu per visit, so a restaurant that sums 44 veg dishes
// across breakfast/lunch/dinner really offers ~11 at any sitting. We therefore
// rank and headline by the BEST SINGLE MENU's veg count, show the per-menu
// breakdown, and highlight a few example dishes (the priciest veg dishes — the
// most expensive item is usually the most substantial, i.e. a "main").

/** Parse a price string ("€7.50", "€29", "12", "8.00") to a number, or null if
 *  there's no usable number (e.g. "Market Price", empty). */
export function parsePrice(price: string | null | undefined): number | null {
  if (!price) return null;
  const cleaned = price.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isVeg(dish: Dish): boolean {
  return dish.classification === 'vegan' || dish.classification === 'vegetarian';
}

/** Live (non-deleted) dishes of a section. */
function liveDishes(section: MenuSection): Dish[] {
  return section.dishes.filter((d) => !d.deletedAt);
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
  /** All veg (vegan + vegetarian) dishes in this menu, sides included. */
  vegOptions: number;
}

export interface GuideInsights {
  /** Best single menu's veg count — the guide headline + ranking key. */
  maxVegOptions: number;
  /** The best single menu's vegan / vegetarian split (shown once on the card). */
  bestMenu: { label: string | null; vegan: number; vegetarian: number };
  /** Veg options per source menu, in display order. */
  perMenu: PerMenuVeg[];
  /** All live dishes across every menu (sides included). */
  totalDishes: number;
  /** Up to 3 example veg dishes — the priciest (≈ the mains). Names only. */
  highlights: string[];
}

const MAX_HIGHLIGHTS = 3;

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

  const perMenu: PerMenuVeg[] = order.map((label) => {
    const dishes = byLabel.get(label)!.flatMap(liveDishes);
    return { label, vegOptions: dishes.filter(isVeg).length };
  });

  // Best single menu = the one with the most veg options; its vegan/veg split.
  let bestLabel: string | null = order[0] ?? null;
  let maxVegOptions = 0;
  for (const m of perMenu) {
    if (m.vegOptions > maxVegOptions) {
      maxVegOptions = m.vegOptions;
      bestLabel = m.label;
    }
  }
  const bestDishes = (byLabel.get(bestLabel) ?? []).flatMap(liveDishes);
  const bestMenu = {
    label: bestLabel,
    vegan: bestDishes.filter((d) => d.classification === 'vegan').length,
    vegetarian: bestDishes.filter((d) => d.classification === 'vegetarian').length,
  };

  const totalDishes = restaurant.sections.flatMap(liveDishes).length;

  // Highlights: the priciest veg dishes across the restaurant (most expensive ≈
  // most substantial ≈ a main), de-duped by normalized name so the same dish on
  // several menus counts once. Unpriced dishes can't be ranked, so they're
  // excluded from highlights.
  const seen = new Set<string>();
  const pricedVeg: Array<{ name: string; price: number }> = [];
  for (const section of restaurant.sections) {
    for (const dish of liveDishes(section)) {
      if (!isVeg(dish)) continue;
      const price = parsePrice(dish.price);
      if (price === null) continue;
      const key = normalizeDishName(dish.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pricedVeg.push({ name: dish.name.trim(), price });
    }
  }
  const highlights = pricedVeg
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_HIGHLIGHTS)
    .map((d) => d.name);

  return { maxVegOptions, bestMenu, perMenu, totalDishes, highlights };
}
