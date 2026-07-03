import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeScrape, loadFixture, MENU_LIKE_TEXT } from './helpers';
import type { LabeledCandidate } from '@/lib/ai';

// Mock the LLM labeler (deterministic) and the scraper's network entry point
// (deep discovery). Everything else in discovery runs for real.
vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>();
  return { ...actual, labelMenuCandidates: vi.fn() };
});
vi.mock('@/lib/scraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scraper')>();
  return { ...actual, scrapeRestaurant: vi.fn() };
});

import { discoverMenus, MAX_PICKER_CANDIDATES, DRINK_SOURCE_RE, textLooksLikeMenu } from '@/lib/menu-discovery';
import { labelMenuCandidates } from '@/lib/ai';
import { scrapeRestaurant } from '@/lib/scraper';

const mockLabeler = vi.mocked(labelMenuCandidates);
const mockScrape = vi.mocked(scrapeRestaurant);

/** Default labeler mock: echo hints back as labels, all distinct food menus. */
function labelerEcho(): void {
  mockLabeler.mockImplementation(async (candidates) =>
    candidates.map((c) => ({
      ref: c.ref,
      label: c.hint || 'Menu',
      isDistinctMenu: true,
      isDrinkOnly: false,
      duplicateOf: null,
    }))
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  labelerEcho();
});

describe('image candidates are internal fallback only (the "Menu images" bug)', () => {
  it('does NOT offer an image candidate when a PDF menu exists', async () => {
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/dinner.pdf'],
      menuImages: ['https://example-restaurant.ie/dumplings-photo.jpg'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates.some((c) => c.type === 'image')).toBe(false);
    expect(res.candidates.some((c) => c.type === 'pdf')).toBe(true);
  });

  it('does NOT offer an image candidate when inline text is a menu', async () => {
    const scrape = makeScrape({
      menuText: MENU_LIKE_TEXT,
      menuImages: ['https://example-restaurant.ie/gallery1.jpg'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates.some((c) => c.type === 'image')).toBe(false);
  });

  it('offers exactly one image candidate labeled "Menu" on image-only sites', async () => {
    const scrape = makeScrape({
      menuText: 'Welcome to our restaurant. Follow us on Instagram for updates and news about events.',
      menuImages: ['https://example-restaurant.ie/board1.jpg', 'https://example-restaurant.ie/board2.jpg'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].type).toBe('image');
    expect(res.candidates[0].label).toBe('Menu');
    expect(res.candidates[0].label.toLowerCase()).not.toContain('images');
  });

  it('never emits a candidate labeled "Menu Images"', async () => {
    const scrape = makeScrape({
      menuText: MENU_LIKE_TEXT,
      menuPdfUrls: ['https://example-restaurant.ie/menu.pdf'],
      menuImages: ['https://example-restaurant.ie/a.jpg', 'https://example-restaurant.ie/b.jpg'],
      menuLinks: ['https://example-restaurant.ie/lunch'],
    });
    const res = await discoverMenus(scrape);
    for (const c of res.candidates) {
      expect(c.label.toLowerCase()).not.toMatch(/menu images/);
    }
  });
});

describe('drink-only menus are never offered (wine-list bug)', () => {
  it('drops wine-list PDFs via the keyword pre-filter', async () => {
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/food-menu.pdf', 'https://example-restaurant.ie/wine-list.pdf'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].ref).toContain('food-menu');
  });

  it('drops candidates the labeler marks isDrinkOnly', async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c, i) => ({
        ref: c.ref,
        label: i === 1 ? 'Cocktails' : 'Dinner',
        isDistinctMenu: true,
        isDrinkOnly: i === 1,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/dinner.pdf', 'https://example-restaurant.ie/sips.pdf'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].label).toBe('Dinner');
  });

  it('DRINK_SOURCE_RE catches common drink-menu slugs but not food slugs', () => {
    for (const s of ['wine list', 'wine-list', 'drinks', 'cocktail menu', 'bar menu', 'beverages']) {
      expect(DRINK_SOURCE_RE.test(s)).toBe(true);
    }
    for (const s of ['dinner menu', 'lunch', 'a la carte', 'brunch', 'food']) {
      expect(DRINK_SOURCE_RE.test(s)).toBe(false);
    }
  });

  it('recovers with a fallback candidate if filtering empties the list', async () => {
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/wine-list.pdf'],
      menuText:
        'Some generic welcome text that is long enough to be used as fallback text for extraction here, well past the one hundred character minimum.',
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates.length).toBeGreaterThan(0);
  });
});

describe('coherent picker lists (jaru.ie bug)', () => {
  it('collapses duplicateOf groups keeping the preferred format (pdf > subpage)', async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c, i) => ({
        ref: c.ref,
        label: i === 0 ? 'Dinner' : i === 1 ? 'Dinner (web)' : 'Lunch',
        isDistinctMenu: true,
        isDrinkOnly: false,
        duplicateOf: i === 1 ? 0 : null, // subpage duplicates the pdf
      }))
    );
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/dinner.pdf'],
      menuLinks: ['https://example-restaurant.ie/dinner', 'https://example-restaurant.ie/lunch'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates.map((c) => c.type).sort()).toEqual(['pdf', 'subpage']);
    expect(res.candidates.find((c) => c.type === 'pdf')!.label).toBe('Dinner');
  });

  it('keeps distinct sources with colliding labels, disambiguated with suffixes', async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c) => ({
        ref: c.ref,
        label: 'Menu', // labeler failed to distinguish (e.g. hash-named PDFs)
        isDistinctMenu: true,
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({
      menuLinks: [
        'https://example-restaurant.ie/menu-1',
        'https://example-restaurant.ie/menu-2',
        'https://example-restaurant.ie/menu-3',
      ],
    });
    const res = await discoverMenus(scrape);
    // Hiding a real menu is worse than an awkward name — all three stay.
    expect(res.candidates).toHaveLength(3);
    expect(new Set(res.candidates.map((c) => c.label)).size).toBe(3);
  });

  it('uses anchor text as the hint for opaque PDF filenames', async () => {
    const captured: Array<{ hint: string }> = [];
    mockLabeler.mockImplementation(async (candidates) => {
      captured.push(...candidates.map((c) => ({ hint: c.hint })));
      return candidates.map((c) => ({
        ref: c.ref,
        label: c.hint || 'Menu',
        isDistinctMenu: true,
        isDrinkOnly: false,
        duplicateOf: null,
      }));
    });
    const pdf = 'https://example-restaurant.ie/_files/ugd/aab7fb_dbea9641da354abcb84218dca7c1e035.pdf';
    const scrape = makeScrape({
      menuPdfUrls: [pdf],
      linkLabels: { [pdf]: 'Dinner Menu' },
    });
    const res = await discoverMenus(scrape);
    expect(captured[0].hint).toBe('Dinner Menu');
    expect(res.candidates[0].label).toBe('Dinner Menu');
  });

  it(`caps the picker at ${MAX_PICKER_CANDIDATES} options`, async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c, i) => ({
        ref: c.ref,
        label: `Menu ${i}`,
        isDistinctMenu: true,
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({
      menuLinks: Array.from({ length: 10 }, (_, i) => `https://example-restaurant.ie/menu-${i}`),
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates.length).toBeLessThanOrEqual(MAX_PICKER_CANDIDATES);
  });

  it('drops non-distinct subpage links (nav/about/gallery)', async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c) => ({
        ref: c.ref,
        label: c.hint || 'Menu',
        isDistinctMenu: !c.ref.includes('about'),
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({
      menuLinks: ['https://example-restaurant.ie/menu', 'https://example-restaurant.ie/about-food'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].ref).toContain('/menu');
  });
});

describe('deep discovery (one hop, only when nothing was found)', () => {
  it('does not scrape nav links when the landing page has a menu source', async () => {
    const scrape = makeScrape({
      menuPdfUrls: ['https://example-restaurant.ie/menu.pdf'],
      navLinks: ['https://example-restaurant.ie/restaurants'],
    });
    await discoverMenus(scrape);
    expect(mockScrape).not.toHaveBeenCalled();
  });

  it('follows nav links and harvests menu sources when landing page has none', async () => {
    mockScrape.mockResolvedValue(
      makeScrape({
        canonicalUrl: 'https://example-restaurant.ie/restaurants/city-centre',
        menuPdfUrls: ['https://example-restaurant.ie/city-food.pdf'],
      })
    );
    const scrape = makeScrape({
      menuText: 'A restaurant group with several locations around the city. Visit our restaurants page for details and directions.',
      navLinks: ['https://example-restaurant.ie/restaurants'],
    });
    const res = await discoverMenus(scrape);
    expect(mockScrape).toHaveBeenCalledWith('https://example-restaurant.ie/restaurants');
    expect(res.candidates.some((c) => c.type === 'pdf' && c.ref.includes('city-food'))).toBe(true);
  });

  it('survives deep-scrape failures and falls back gracefully', async () => {
    mockScrape.mockRejectedValue(new Error('network down'));
    const scrape = makeScrape({
      menuText:
        'Welcome to our lovely place. We are open every day from noon until late in the evening for you, and we look forward to seeing you soon.',
      navLinks: ['https://example-restaurant.ie/somewhere'],
    });
    const res = await discoverMenus(scrape);
    // Guaranteed fallback: inline text candidate.
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].type).toBe('text');
  });
});

describe('text heuristics', () => {
  it('accepts real menu text', () => {
    expect(textLooksLikeMenu(MENU_LIKE_TEXT)).toBe(true);
  });
  it('rejects short or non-menu text', () => {
    expect(textLooksLikeMenu('')).toBe(false);
    expect(textLooksLikeMenu('Welcome to our restaurant')).toBe(false);
    expect(
      textLooksLikeMenu(
        'We are a family-run business established in 1998. Our opening hours are Monday to Sunday. Book a table online or call us today for reservations and private events.'
      )
    ).toBe(false);
  });
});

describe('recorded fixtures (skipped when not recorded)', () => {
  it('multi-menu site (vintage kitchen): no image candidate, no wine list', async () => {
    const scrape = loadFixture('multi-menu');
    if (!scrape) return; // fixture not recorded in this environment
    const res = await discoverMenus(scrape);
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.candidates.some((c) => c.type === 'image')).toBe(false);
    for (const c of res.candidates) {
      expect(DRINK_SOURCE_RE.test(c.ref)).toBe(false);
    }
  });

  it('image-only site (notions): at most one candidate offered', async () => {
    const scrape = loadFixture('image-only');
    if (!scrape) return;
    const res = await discoverMenus(scrape);
    const imageCandidates = res.candidates.filter((c) => c.type === 'image');
    expect(imageCandidates.length).toBeLessThanOrEqual(1);
  });
});
