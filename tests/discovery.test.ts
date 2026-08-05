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

  it('does not mistake opening-hours ranges for prices (kickys.ie bug)', () => {
    // Real landing-page copy: a dozen "5.30-9.30"-style hour ranges used to
    // score >=8 "prices" under the old regex, outscoring the site's actual
    // menu subpage and starving discovery of the real content.
    const openingHoursOnly = `
      OPENING HOURS
      Monday: 5.30-9.30
      Tuesday: 5.30-9.30
      Wednesday: 5.30-9.30
      Thursday: 12.30-2.30 & 5.30-9.30
      Friday: 12.30-2.30 & 5.30-9.30
      Saturday: 1.00-9.30
      Dinner. Lunch. Book a table online or follow us for updates.
    `;
    expect(textLooksLikeMenu(openingHoursOnly)).toBe(false);
  });

  it('still counts a real bare-decimal price with no currency symbol', () => {
    const menuText = `
      Starters: Soup 6.50, Calamari 9.00, Burrata 11.00, Garlic bread 5.00
      Mains: Burger 16.50, Pizza 14.00, Risotto 15.50, Seabass 22.00
    `;
    expect(textLooksLikeMenu(menuText)).toBe(true);
  });
});

describe('content-validated subpage survives a generic label (kickys.ie bug)', () => {
  it('prefers the real menu subpage over landing-page opening-hours copy, even when the labeler can\'t confirm it\'s distinct', async () => {
    const subpageUrl = 'https://example-restaurant.ie/our-menus/';
    // Deep discovery fetches the subpage itself and finds a real menu there.
    mockScrape.mockResolvedValue(
      makeScrape({ canonicalUrl: subpageUrl, menuText: MENU_LIKE_TEXT })
    );
    // The labeler only ever sees a generic anchor hint ("Menus") and the URL —
    // no page content — so it can plausibly (and, per the real bug, actually
    // did) guess this isn't a distinct menu.
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c) => ({
        ref: c.ref,
        label: c.hint || 'Menu',
        isDistinctMenu: false,
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({
      // The homepage's OWN text is just opening hours — not a real menu.
      menuText: 'Monday: 5.30-9.30\nTuesday: 5.30-9.30\nDinner. Lunch. Book a table today.',
      menuLinks: [subpageUrl],
      navLinks: [subpageUrl],
      linkLabels: { [subpageUrl]: 'Menus' },
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].type).toBe('subpage');
    expect(res.candidates[0].ref).toBe(subpageUrl);
  });
});

describe('genuinely no menu — zero candidates, not a hallucinated fallback (bibis.ie / sprezzaturadublin.ie-class sites)', () => {
  it('produces zero candidates for a real site with no menu text, PDFs, or images', async () => {
    // Matches what bibis.ie and sprezzaturadublin.ie actually scraped as
    // during manual review: some page content, but no prices, no food
    // words, no PDF, no usable image — this precondition is what the
    // discover route uses to show the friendly "no menu" screen instead of
    // an error, so it must not silently invent a candidate.
    const scrape = makeScrape({
      menuText: 'Follow us on Instagram for the latest updates and events. See you soon!',
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(0);
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

describe('the 2026-08-05 "no menu listed on this site" cluster', () => {
  it('a price-free landing blurb does NOT suppress the deeper crawl (linastores.co.uk)', async () => {
    // Lina Stores' homepage lists its eight branches with enough food words
    // ("Delicatessen", "pasta", "lunch"…) to trip textLooksLikeMenu's
    // priceless-menu clause. That counted as a strong source, deep discovery
    // never ran, and the eight real location menus were never found — the user
    // saw "No menu listed on this site" for a chain with a menu on every page.
    const locationsBlurb =
      'Our Locations. Brewer Street Delicatessen, Soho London. Greek Street Restaurant. ' +
      'Stable Street Restaurant and Delicatessen. Fresh pasta made daily, served for lunch and dinner. ' +
      'Sharing plates and seasonal salad. Book a table for brunch or dinner at any of our restaurants. '.repeat(6);
    const scrape = makeScrape({
      menuText: locationsBlurb,
      navLinks: ['https://www.linastores.co.uk/locations/stable-street-restaurant-delicatessen'],
    });
    mockScrape.mockResolvedValue(
      makeScrape({
        canonicalUrl: 'https://www.linastores.co.uk/locations/stable-street-restaurant-delicatessen',
        menuLinks: ['https://www.linastores.co.uk/locations/stable-street-restaurant-delicatessen?menu=menu'],
        linkLabels: {
          'https://www.linastores.co.uk/locations/stable-street-restaurant-delicatessen?menu=menu': 'View Menus',
        },
      })
    );

    const res = await discoverMenus(scrape);
    expect(mockScrape).toHaveBeenCalled(); // deep discovery ran at all
    expect(res.candidates.some((c) => c.ref.includes('?menu=menu'))).toBe(true);
  });

  it('a priced menu on the landing page still short-circuits the crawl (no extra fetches)', async () => {
    const res = await discoverMenus(makeScrape({ menuText: MENU_LIKE_TEXT, navLinks: ['https://x.ie/dining'] }));
    expect(mockScrape).not.toHaveBeenCalled();
    expect(res.candidates.some((c) => c.type === 'text')).toBe(true);
  });

  it('keeps the English menu and drops its Dutch twin (restaurantdekas.com)', async () => {
    const scrape = makeScrape({
      menuLinks: ['https://restaurantdekas.com/nl/menu', 'https://restaurantdekas.com/eng/menu'],
    });
    const res = await discoverMenus(scrape);
    const refs = res.candidates.map((c) => c.ref);
    expect(refs).toContain('https://restaurantdekas.com/eng/menu');
    expect(refs).not.toContain('https://restaurantdekas.com/nl/menu');
  });

  it('keeps both when they are genuinely different menus, not language twins', async () => {
    const scrape = makeScrape({
      menuLinks: ['https://example.com/eng/lunch', 'https://example.com/eng/dinner'],
    });
    const res = await discoverMenus(scrape);
    expect(res.candidates).toHaveLength(2);
  });

  it('follows a chain homepage into one branch when the locations page is a dead end', async () => {
    // Group homepage → /locations (no menu of its own) → a branch page that has
    // the menu. One hop can never reach it; the second hop is bounded to a
    // single branch on purpose.
    const scrape = makeScrape({ navLinks: ['https://chain.com/locations'] });
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://chain.com/locations') {
        return makeScrape({
          canonicalUrl: url,
          title: 'Our Locations',
          navLinks: ['https://chain.com/locations/soho'],
        });
      }
      return makeScrape({
        canonicalUrl: 'https://chain.com/locations/soho',
        menuPdfUrls: ['https://chain.com/menus/soho-dinner.pdf'],
      });
    });

    const res = await discoverMenus(scrape);
    expect(res.candidates.some((c) => c.ref === 'https://chain.com/menus/soho-dinner.pdf')).toBe(true);
  });
});

describe('a subpage named "menu" survives a wrong labeler verdict (neni-amsterdam.nl)', () => {
  it('keeps /menus even when the labeler says it is not distinct', async () => {
    // NENI's /menus page was found correctly, then judged "not distinct" and
    // dropped, leaving only homepage nav text — the restaurant came back with
    // no dishes. The labeler never sees page content, so its guess is the
    // weaker signal against a URL that literally says "menus".
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c) => ({
        ref: c.ref,
        label: c.hint || 'Menu',
        isDistinctMenu: false,
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({ menuLinks: ['https://neni-amsterdam.nl/menus'] });
    const res = await discoverMenus(scrape);
    expect(res.candidates.some((c) => c.ref === 'https://neni-amsterdam.nl/menus')).toBe(true);
  });

  it('still drops a non-menu subpage the labeler rejects', async () => {
    mockLabeler.mockImplementation(async (candidates) =>
      candidates.map((c) => ({
        ref: c.ref,
        label: c.hint || 'Page',
        isDistinctMenu: false,
        isDrinkOnly: false,
        duplicateOf: null,
      }))
    );
    const scrape = makeScrape({ menuLinks: ['https://example.com/order-takeaway'] });
    const res = await discoverMenus(scrape);
    expect(res.candidates.some((c) => c.ref.includes('order-takeaway'))).toBe(false);
  });
});

describe('each branch of a chain becomes its own named menu (founder, 2026-08-05)', () => {
  it('labels menus by location and keeps several branches', async () => {
    const scrape = makeScrape({ navLinks: ['https://chain.com/locations'] });
    mockScrape.mockImplementation(async (url: string) => {
      if (url === 'https://chain.com/locations') {
        return makeScrape({
          canonicalUrl: url,
          title: 'Our Locations',
          navLinks: ['https://chain.com/locations/soho', 'https://chain.com/locations/kings-cross'],
        });
      }
      const slug = url.split('/').pop();
      return makeScrape({ canonicalUrl: url, menuPdfUrls: [`https://chain.com/menus/${slug}.pdf`] });
    });

    const res = await discoverMenus(scrape);
    const labels = res.candidates.map((c) => c.label.toLowerCase()).join(' | ');
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(labels).toContain('soho');
    expect(labels).toContain('kings cross');
  });
});
