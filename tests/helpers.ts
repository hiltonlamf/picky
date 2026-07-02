import type { ScrapeResult } from '@/lib/scraper';
import type { ClassifiedMenu, RawDish } from '@/types';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/** Minimal ScrapeResult with overrides — the unit-test workhorse. */
export function makeScrape(overrides: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    url: 'https://example-restaurant.ie',
    canonicalUrl: 'https://example-restaurant.ie',
    title: 'Example Restaurant',
    menuText: '',
    menuUrl: null,
    urlType: 'html',
    ...overrides,
  };
}

/** Load a recorded ScrapeResult fixture; returns null if not recorded. */
export function loadFixture(name: string): ScrapeResult | null {
  const file = path.join(__dirname, 'fixtures', `${name}.json`);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { scrape: ScrapeResult };
  return parsed.scrape;
}

export function makeDish(name: string, overrides: Partial<RawDish> = {}): RawDish {
  return {
    name,
    classification: 'vegetarian',
    confidence: 0.8,
    reason: 'test',
    ...overrides,
  };
}

export function makeMenu(sections: Array<{ name: string; dishes: RawDish[] }>): ClassifiedMenu {
  return { restaurantName: 'Example Restaurant', language: 'English', sections };
}

/** Text that satisfies textLooksLikeMenu (prices + menu words). */
export const MENU_LIKE_TEXT = `
  Starters — Soup of the day €6.50, Crispy calamari €9.00, Burrata salad €11.00, Garlic bread €5.00
  Mains — Beef burger €16.50, Margherita pizza €14.00, Wild mushroom risotto €15.50, Pan-fried seabass €22.00
  Desserts — Chocolate brownie €7.00, Panna cotta €7.50
`.repeat(2);
