import type { MenuCandidate, MenuCandidateType } from '@/types';
import { scrapeRestaurant, type ScrapeResult } from './scraper';
import { labelMenuCandidates, LabeledCandidate, type AIUsage } from './ai';

export interface DiscoveryResult {
  candidates: MenuCandidate[];
  inlineText: string; // homepage/landing menu text if present
  restaurantTitle: string;
  finalUrl: string;
  screenshotUrl?: string;
  /** Cost of the candidate-labelling call. Undefined when discovery made no AI
   *  call at all (no candidates, or the call threw). Callers must add this to
   *  whatever total they book, or they under-report by one call per analysis. */
  usage?: AIUsage;
}

/** Max menu options shown in the picker — beyond this the list stops being a choice. */
export const MAX_PICKER_CANDIDATES = 6;

/** A URL path segment that's just a language marker (`/nl/`, `/eng/`, ...) —
 *  shared by discoverMenus' language-variant-sibling check and
 *  preferEnglishSiblings' same-menu-per-language dedup below. */
const LANG_SEGMENT_RE = /\/(en|eng|english|nl|de|fr|es|it|pt|da|sv|no|fi|pl|zh|zh-hans|ja)(\/|$)/i;

/** Stable, non-cryptographic id for a candidate (FNV-1a, 32-bit, hex). */
function candidateId(type: MenuCandidateType, ref: string): string {
  const input = `${type}|${ref}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Course/section words that signal "this text is a menu". English first, then a
// generic set of common European course words so a non-English menu (Dutch,
// French, German, Italian, Spanish) isn't rejected just for lacking English
// words — the app targets NL/UK/IE now but this keeps discovery language-robust
// wherever a menu can't be read in English. Not exhaustive per language; these
// are the high-signal, low-false-positive tokens.
const MENU_WORD_RE =
  /\b(starter|main|dessert|appetiser|appetizer|entr[ée]e|side|sharing|à la carte|a la carte|course|salad|soup|pasta|pizza|risotto|burger|brunch|lunch|dinner|voorgerecht|hoofdgerecht|nagerecht|tussengerecht|bijgerecht|gerechten|menukaart|lunchkaart|soep|salade|vorspeise|hauptgericht|hauptspeise|nachspeise|nachtisch|beilage|suppe|salat|antipast|prim[io]|second[io]|contorni|dolci|entrantes|principales|postres|ensalada|plats?)\b/i;

// A bare "X.XX" number (no currency symbol) is ambiguous with opening-hours
// time ranges written the European way ("5.30-9.30", "Mon 12.30-2.30") — a
// landing page's opening-hours block can rack up a dozen of these and get
// mistaken for a priced menu (found on kickys.ie: the homepage's hours list
// out-scored the real /our-menus/ subpage's own dish list). Both sides of a
// hyphen/en-dash-joined pair are excluded; a currency-prefixed price is exempt
// since "€5.30-9.30" isn't a real menu pattern anyway.
const BARE_DECIMAL_PRICE_RE =
  /\b(?<!\d{1,2}\.\d{2}[-–]\s{0,3})\d{1,3}\.\d{2}\b(?![^\d]{0,3}[-–]\s*\d{1,2}\.\d{2}\b)/g;

function priceTokenCount(text: string): number {
  const currencyTokens = (text.match(/(?:€|£|\$)\s?\d/g) ?? []).length;
  const bareDecimalTokens = (text.match(BARE_DECIMAL_PRICE_RE) ?? []).length;
  return currencyTokens + bareDecimalTokens;
}

/** Heuristic: does this text actually read like a menu (prices + food words)? */
export function textLooksLikeMenu(text: string): boolean {
  if (!text || text.length < 100) return false;
  const priceTokens = priceTokenCount(text);
  const hasMenuWords = MENU_WORD_RE.test(text);
  // Priceless menus (tasting menus) list many courses — a single menu word in
  // a long marketing page ("seasonal sharing plates…") is not a menu.
  const menuWordCount = (text.match(new RegExp(MENU_WORD_RE.source, 'gi')) ?? []).length;
  return (priceTokens >= 4 && hasMenuWords) || (priceTokens >= 8) || (menuWordCount >= 5 && text.length > 1500);
}

/**
 * A menu we'd bet the whole discovery on. Deliberately stricter than
 * `textLooksLikeMenu`: its priceless-menu clause (5+ menu words in a long page)
 * is generous on purpose, and a restaurant-group landing page trips it easily —
 * linastores.co.uk's "Our Locations / Delicatessen / … fresh pasta" blurb scored
 * as a menu, which suppressed the deeper crawl and left the eight real location
 * menus undiscovered. Real prices are the signal that a page IS the menu rather
 * than merely talking about food.
 */
function textIsConfidentMenu(text: string): boolean {
  return textLooksLikeMenu(text) && priceTokenCount(text) >= 4;
}

/**
 * Drink-only menu sources (wine lists, cocktail lists...). The app analyses
 * food only, so these are dropped before they ever reach the picker.
 */
export const DRINK_SOURCE_RE =
  /\b(wine|wines|winelist|drink|drinks|beverage|beverages|cocktail|cocktails|spirits|aperitif|digestif|bar\s?list|bar\s?menu|beer\s?list|gin\s?list|whisk(e)?y\s?list|vino|vinos|boissons|bebidas|dranken|drankenkaart|wijn|wijnen|wijnkaart|bieren|bierkaart|getr[äa]nke|weinkarte|weine)\b/i;

/**
 * Not real dining menus — allergen sheets, catering/collection/delivery/takeaway
 * ordering, kids' menus (not the guide's audience), gift vouchers, group-booking
 * packages. Dropped in discovery so they never become a "menu" for ANY
 * restaurant or city. Kept separate from DRINK_SOURCE_RE for clarity.
 *
 * NOT here: cook-at-home menus. "Dine at Home" was added to this list and the
 * founder overruled it (2026-08-23) — rasam.ie's Dine at Home is one of the
 * three menus he wants diners to see, alongside Early Bird and A La Carte. A
 * menu of real food the restaurant cooks is a menu, even if you finish it at
 * home; only ORDERING channels (delivery/collection/takeaway) are excluded.
 */
export const NON_FOOD_MENU_RE =
  /\b(allergens?|allerg(y|ies)|catering|collection|click\s?[&+and]*\s?collect|delivery|take\s?away|take\s?out|kids?|childrens?|children'?s|gift|voucher|group\s?booking|sample\s?menu|private\s?dining|pdr|hire|christmas\s?party|function\s?pack)\b/i;

/**
 * A menu source whose name says WHICH menu it is — a meal, a sitting, or a
 * service. Used to decide that a site names its menus explicitly, so its
 * homepage body text is a teaser rather than the menu itself.
 *
 * The bare words "menu"/"menus" are excluded ON PURPOSE. That is exactly the
 * label that sits beside a homepage which genuinely IS the full menu:
 * misters.ie (a smoke-test case) links to "/menu", and baanthai.ie has a
 * 20k-character homepage menu next to a THIRD-PARTY ".../restaurant/menus/"
 * link. Counting those would suppress the real menu on both. It would also
 * re-open the linastores.co.uk regression, whose deep-discovered link label is
 * literally "View Menus".
 *
 * The à-la-carte alternative sits OUTSIDE the \b(...)\b wrapper deliberately:
 * JavaScript's \b is ASCII-only, so "à" is not a word character and `\bà` can
 * never match. Written the obvious way, "À La Carte" is silently missed.
 */
const SPECIFIC_MENU_NAME_RE =
  /[àa]\s?la\s?carte|\b(lunch|dinner|brunch|breakfast|early\s?bird|late\s?bird|pre[-\s]?theatre|pre[-\s]?theater|tasting|set\s?(menu|lunch|dinner)|sunday|evening|weekend|seasonal|lunchkaart|diner|midi|soir)\b/i;

/** True if a menu label / hint is a non-food menu that should never be captured. */
export function isNonFoodMenu(text: string): boolean {
  return NON_FOOD_MENU_RE.test(text ?? '');
}

/** Turn a URL into a short human hint from its slug, e.g. ".../wine-list.pdf" → "wine list". */
export function hintFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last)
      .replace(/\.(pdf|jpe?g|png|webp|html?)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

type Raw = {
  type: MenuCandidateType;
  ref: string;
  hint: string;
  source: MenuCandidate['source'];
  /** Set when we've directly fetched this subpage and confirmed its own
   *  content passes textLooksLikeMenu — not just a guess from a URL/anchor
   *  hint. Lets it survive a false "not distinct" verdict from the labeler,
   *  same as text/pdf candidates (see the `kept` filter below). */
  contentValidated?: boolean;
};

/** The landing page's own body text, offered as a menu because it reads like
 *  one. It has no URL and no name of its own, so it is the one candidate whose
 *  label we never let the AI invent. */
const isHomepageText = (r: Raw): boolean => r.type === 'text' && r.source === 'homepage';

/**
 * Which of two candidates for the SAME url to keep. A content-validated
 * candidate always wins (we actually fetched it and confirmed it reads like a
 * menu); otherwise the better format wins, so one document offered as both a
 * PDF and a subpage is kept as the PDF — the format extraction reads best.
 */
function preferredOf(a: Raw, b: Raw): Raw {
  if (!!a.contentValidated !== !!b.contentValidated) return a.contentValidated ? a : b;
  // Strict <: on a tie the incumbent (b) is kept, so discovery order still
  // decides, exactly as it did before this dedupe key changed.
  return FORMAT_PREFERENCE[a.type] < FORMAT_PREFERENCE[b.type] ? a : b;
}

/** How many nav links the deep pass follows, and its total time budget. */
const DEEP_NAV_LINKS = 3;
const DEEP_BUDGET_MS = 15000;

/** Slugs that mark a page as "a list of branches", not a menu in itself. */
const LOCATION_INDEX_RE = /\b(location|locations|venue|venues|restaurants|branches|find[-\s]?us|our[-\s]?places)\b/i;

/** A link that looks like one specific branch of a chain (…/locations/soho). */
function looksLikeBranchLink(url: string): boolean {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    return segments.some((s) => LOCATION_INDEX_RE.test(s));
  } catch {
    return false;
  }
}

/**
 * How many branches of a chain we read menus from.
 *
 * Founder's call (2026-08-05): a multi-location restaurant should present like
 * a restaurant with several menus — the way lunch/dinner/tasting already do —
 * rather than us picking one branch and hiding the rest. Capped at three so a
 * twenty-site group can't turn one search into twenty crawls.
 */
const MAX_BRANCHES = 3;

/** Human name for a branch, from its URL slug: ".../locations/greek-street" →
 *  "greek street". Used as a menu label so the picker reads "Greek Street" the
 *  same way it reads "Lunch". */
function branchLabel(url: string): string {
  const slug = hintFromUrl(url);
  return slug && !isOpaqueHint(slug) ? slug : '';
}

/** Prefix a menu hint with its branch, so several locations' menus stay
 *  tellable apart in the picker ("Greek Street — Dinner"). */
function withBranch(label: string, hint: string): string {
  if (!label) return hint;
  if (!hint) return label;
  return hint.toLowerCase().includes(label.toLowerCase()) ? hint : `${label} — ${hint}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null);
}

/**
 * Deep discovery, one hop, bounded: when the landing page yields NO menu
 * source at all, follow the top scored nav links (e.g. a "Restaurants" or
 * "Dining" section on a multi-venue site) and harvest menu sources from those
 * pages. Never triggers when the first pass found anything, so it cannot
 * affect sites that already work.
 */
async function deepDiscoverRaw(navLinks: string[]): Promise<Raw[]> {
  const targets = navLinks.slice(0, DEEP_NAV_LINKS);
  if (targets.length === 0) return [];

  const subs = await Promise.all(targets.map((u) => withTimeout(scrapeRestaurant(u), DEEP_BUDGET_MS)));

  const raw: Raw[] = [];
  /** Branch pages worth a second hop, if this first hop finds nothing. */
  const branchLeads: string[] = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    if (!sub) continue;
    const before = raw.length;
    // When this hop IS a branch page, name everything it yields after the
    // branch so two locations' menus don't both come back as "Menu".
    const venue = looksLikeBranchLink(targets[i]) ? branchLabel(targets[i]) : '';
    for (const pdf of sub.menuPdfUrls ?? []) {
      raw.push({
        type: 'pdf',
        ref: pdf,
        hint: withBranch(venue, sub.linkLabels?.[pdf] || hintFromUrl(pdf)),
        source: 'subpage',
      });
    }
    for (const link of sub.menuLinks ?? []) {
      raw.push({
        type: 'subpage',
        ref: link,
        hint: withBranch(venue, sub.linkLabels?.[link] || hintFromUrl(link)),
        source: 'subpage',
      });
    }
    // The nav page itself reads like a menu → it's a menu subpage. We've
    // directly confirmed its own content, not just guessed from a link
    // label — mark it so it survives the labeler below even if it can't
    // confidently call a generically-named page ("Menus") distinct.
    if (textLooksLikeMenu(sub.menuText ?? '')) {
      raw.push({
        type: 'subpage',
        ref: sub.canonicalUrl || targets[i],
        hint: hintFromUrl(targets[i]),
        source: 'subpage',
        contentValidated: true,
      });
    }
    // This hop was a dead end, but it looks like a chain's "Locations" index —
    // remember its branch links for a possible second hop.
    if (raw.length === before) {
      const isIndex = LOCATION_INDEX_RE.test(targets[i]) || LOCATION_INDEX_RE.test(sub.title ?? '');
      for (const link of sub.navLinks ?? []) {
        if (looksLikeBranchLink(link)) branchLeads.push(link);
      }
      if (isIndex) {
        for (const link of sub.navLinks ?? []) branchLeads.push(link);
      }
    }
  }

  // Second hop: a restaurant group's menus live on its branch pages (group
  // homepage → Locations → King's Cross → menu), which a single hop can never
  // reach. Each branch becomes its OWN named menu — the founder's model is that
  // locations behave like lunch/dinner menus, not like one menu to choose from.
  if (raw.length === 0 && branchLeads.length > 0) {
    const chosen = Array.from(new Set(branchLeads)).slice(0, MAX_BRANCHES);
    const branches = await Promise.all(chosen.map((u) => withTimeout(scrapeRestaurant(u), DEEP_BUDGET_MS)));
    for (let b = 0; b < branches.length; b++) {
      const branch = branches[b];
      if (!branch) continue;
      const venue = branchLabel(chosen[b]);
      for (const pdf of branch.menuPdfUrls ?? []) {
        raw.push({
          type: 'pdf',
          ref: pdf,
          hint: withBranch(venue, branch.linkLabels?.[pdf] || hintFromUrl(pdf)),
          source: 'subpage',
        });
      }
      for (const link of branch.menuLinks ?? []) {
        raw.push({
          type: 'subpage',
          ref: link,
          hint: withBranch(venue, branch.linkLabels?.[link] || hintFromUrl(link)),
          source: 'subpage',
        });
      }
      if (textLooksLikeMenu(branch.menuText ?? '')) {
        raw.push({
          type: 'subpage',
          ref: branch.canonicalUrl || chosen[b],
          hint: venue || hintFromUrl(chosen[b]),
          source: 'subpage',
          contentValidated: true,
        });
      }
    }
  }
  return raw;
}

/** Opaque slug (CDN hash like "aab7fb dbea9641...") — useless as a human hint. */
function isOpaqueHint(hint: string): boolean {
  if (!hint) return true;
  const words = hint.split(/\s+/);
  const hexish = words.filter((w) => /^[0-9a-f]{6,}$/i.test(w) || /^\d+$/.test(w)).length;
  return hexish >= Math.max(1, words.length - 1);
}

/** Format preference when the same menu exists in several formats: PDFs are
 * self-contained; a dedicated menu subpage beats the landing-page text (which
 * is often nav/hero copy the labeler mistakes for "the menu"). */
const FORMAT_PREFERENCE: Record<MenuCandidateType, number> = { pdf: 0, subpage: 1, text: 2, image: 3 };

function toCandidate(r: Raw, label: string, description?: string): MenuCandidate {
  return {
    id: candidateId(r.type, r.ref),
    label,
    description,
    type: r.type,
    ref: r.ref,
    source: r.source,
  };
}

/**
 * Enumerate the distinct menu sources on a scraped restaurant page and label
 * them with a cheap LLM pass. The page text itself counts as one "text"
 * candidate when present; PDFs and menu sub-pages are the others.
 *
 * Page images are NOT offered as a menu option when any text/PDF/subpage menu
 * exists — an image is a container a menu might be delivered in, not a menu.
 * They remain available to extraction as a fallback source (ctx.imageUrls),
 * and become the (single, sole) candidate only on image-only sites.
 */
export async function discoverMenus(scrape: ScrapeResult): Promise<DiscoveryResult> {
  const inlineText = scrape.menuText ?? '';
  const finalUrl = scrape.canonicalUrl;

  // Build raw candidates with a type, ref and a human hint for labeling.
  const raw: Raw[] = [];

  // Only treat inline text as a menu candidate when it actually looks like a
  // menu (prices + course words) — avoids a homepage "teaser" masquerading as a
  // menu and creating a false multi-menu prompt alongside a real PDF.
  //
  // The hint is EMPTY on purpose. It used to be the hardcoded string
  // "Main Menu", which is a name we invented: the labeler is handed the hint
  // and no page content, so it could only echo the fabrication straight back,
  // and rasam.ie ended up publishing a "Main Menu" that appears nowhere on its
  // site (its nav offers Early Bird, A La Carte, Wine, Drinks, Dine at Home).
  // Four production restaurants carried an invented menu because of this line.
  // The label is pinned to the neutral "Menu" further down instead.
  if (textLooksLikeMenu(inlineText)) {
    raw.push({ type: 'text', ref: '', hint: '', source: 'homepage' });
  }
  // Prefer the link's anchor text over the URL slug — Wix/Squarespace PDFs have
  // opaque hash filenames while the button says "Lunch" / "Dinner".
  const hintFor = (url: string): string => {
    const anchor = scrape.linkLabels?.[url];
    const slug = hintFromUrl(url);
    if (anchor && (isOpaqueHint(slug) || anchor.length <= slug.length)) return anchor;
    return slug || anchor || '';
  };
  for (const pdf of scrape.menuPdfUrls ?? []) {
    raw.push({ type: 'pdf', ref: pdf, hint: hintFor(pdf), source: 'homepage' });
  }
  // A subpage that's just a language-variant SIBLING of the page discovery
  // already used as its primary source (e.g. finalUrl is /nl/menu, and
  // /eng/menu is a switcher link found ON that page) is the untested case
  // `preferEnglishSiblings` below can't catch: it only compares candidates
  // that are ALREADY in the raw list against each other, but this sibling
  // was found ONE level deeper (during the dive into finalUrl itself) and
  // never independently checked for its own PDF/content — restaurantdekas.com
  // hit exactly this: /nl/menu became finalUrl, its own page links to
  // /eng/menu, and /eng/menu survived into the picker as a confusing "Menu 2"
  // option alongside the real PDF candidate, even though it's nothing more
  // than the same page in another language. Skip it here rather than offer a
  // candidate nobody asked for and that only duplicates what finalUrl already
  // covers.
  const isLanguageVariantOfPrimaryPage = (ref: string): boolean => {
    if (!LANG_SEGMENT_RE.test(ref) || !LANG_SEGMENT_RE.test(finalUrl)) return false;
    return ref.replace(LANG_SEGMENT_RE, '/*$2') === finalUrl.replace(LANG_SEGMENT_RE, '/*$2');
  };
  for (const link of scrape.menuLinks ?? []) {
    if (isLanguageVariantOfPrimaryPage(link)) continue;
    raw.push({ type: 'subpage', ref: link, hint: hintFor(link), source: 'subpage' });
  }

  // De-dupe by ref, and drop obvious drink-only sources (wine lists etc.)
  // before spending tokens on labeling. A subpage discovered both as a plain
  // menuLinks guess AND via deepDiscoverRaw's content-fetched check shares the
  // same type|ref key — prefer the content-validated version so the "first
  // wins" pass below doesn't silently keep the weaker, unvalidated one.
  const dedupeRaw = (items: Raw[]): Raw[] => {
    const byKey = new Map<string, Raw>();
    for (const r of items) {
      // Key on the URL ALONE, not on `type|url`. A menu PDF routinely appears
      // in BOTH menuPdfUrls and menuLinks, so the old key let one document
      // through twice — once as [pdf] and once as [subpage] — and the picker
      // offered the identical file under two names. That is precisely how
      // picklerestaurant.com produced "Main Menu" AND "Main Menu 2" from a
      // single Pickle_JanuaryMainMenu PDF (and "Group Menu 2" from a single
      // group menu). The text candidate has no URL, so it keys on its type.
      const key = r.ref || `${r.type}|`;
      const existing = byKey.get(key);
      if (!existing || preferredOf(r, existing) === r) byKey.set(key, r);
    }
    return Array.from(byKey.values()).filter((r) => {
      const hintText = `${r.hint} ${hintFromUrl(r.ref)}`;
      // Non-food menus (allergen/catering/kids/collection/...) are dropped for
      // ALL source types, including text/pdf — they are never real dining menus.
      if (isNonFoodMenu(hintText)) return false;
      if (r.type !== 'text' && DRINK_SOURCE_RE.test(hintText)) return false;
      return true;
    });
  };

  /**
   * On a multilingual site the same menu shows up once per language
   * (restaurantdekas.com yields /nl/menu AND /eng/menu). Offering both makes
   * the user pick between two copies of one menu and risks extracting the
   * non-English one — which reads worse for our English-first prompts. Keep the
   * English sibling when a pair differs only by its language segment.
   */
  const preferEnglishSiblings = (items: Raw[]): Raw[] => {
    const ENGLISH_SEGMENT_RE = /^(en|eng|english)$/i;
    const keyFor = (ref: string): string | null => {
      if (!LANG_SEGMENT_RE.test(ref)) return null;
      return ref.replace(LANG_SEGMENT_RE, '/*$2');
    };
    const englishByKey = new Set<string>();
    for (const r of items) {
      const key = keyFor(r.ref);
      const seg = LANG_SEGMENT_RE.exec(r.ref)?.[1] ?? '';
      if (key && ENGLISH_SEGMENT_RE.test(seg)) englishByKey.add(key);
    }
    return items.filter((r) => {
      const key = keyFor(r.ref);
      if (!key || !englishByKey.has(key)) return true;
      const seg = LANG_SEGMENT_RE.exec(r.ref)?.[1] ?? '';
      return ENGLISH_SEGMENT_RE.test(seg);
    });
  };

  let deduped = preferEnglishSiblings(dedupeRaw(raw));

  // Deep fallback: the landing page has no self-contained menu source (no
  // priced menu text, no PDF) and at most one subpage lead — follow top nav
  // links one hop (multi-venue sites where menus hide under "Restaurants",
  // JS-heavy chains). A price-free text candidate does NOT count as strong:
  // see textIsConfidentMenu — trusting one is how a chain's locations list
  // became "the menu" and stopped us ever reaching the real ones.
  const hasStrongSource = deduped.some(
    (r) => r.type === 'pdf' || (r.type === 'text' && textIsConfidentMenu(inlineText))
  );
  const subpageCount = deduped.filter((r) => r.type === 'subpage').length;
  if (!hasStrongSource && subpageCount <= 1 && (scrape.navLinks?.length ?? 0) > 0) {
    deduped = preferEnglishSiblings(dedupeRaw([...raw, ...(await deepDiscoverRaw(scrape.navLinks!))]));
  }

  // When a site names its menus explicitly, its homepage body text is a teaser
  // for them, not a menu of its own — rasam.ie's landing page trips
  // textLooksLikeMenu on a blurb while the real menus sit behind "Early Bird
  // Menu" and "A La Carte Menu" links, so we published a phantom third menu
  // whose dishes duplicated the others exactly.
  //
  // Two thresholds carry this rule, and both are load-bearing:
  //
  //  - TWO named menus, not one. A site with its full menu on the homepage
  //    plus a single "Dinner Menu" PDF keeps its homepage text; only a site
  //    that names several sittings is clearly routing diners elsewhere. A
  //    Rasam-shaped site with just one named menu keeps the teaser, which is
  //    the safe side to err on (founder's priority ①: losing a real menu is
  //    worse than one option too many).
  //  - SPECIFIC names only — see SPECIFIC_MENU_NAME_RE for why a bare
  //    "menu"/"menus" link must never count.
  //
  // This MUST run after the deep-fallback block above: hasStrongSource counts
  // the text candidate, so filtering earlier would push sites that short-
  // circuit today into deepDiscoverRaw's three extra scrapes.
  const specificallyNamed = deduped.filter(
    (r) => r.type !== 'text' && SPECIFIC_MENU_NAME_RE.test(`${r.hint} ${hintFromUrl(r.ref)}`)
  );
  if (specificallyNamed.length >= 2) {
    deduped = deduped.filter((r) => !isHomepageText(r));
  }

  let finalCandidates: MenuCandidate[] = [];
  let labelUsage: AIUsage | undefined;

  if (deduped.length > 0) {
    // Label + distinctness/drink/duplicate detection via Haiku.
    // Failures degrade to keeping everything.
    let labeled: LabeledCandidate[];
    try {
      const result = await labelMenuCandidates(
        deduped.map((r) => ({ ref: `${r.type}|${r.ref}`, hint: r.hint, type: r.type, url: r.ref || undefined })),
        scrape.title
      );
      labeled = result.candidates;
      // This call is billed. Carry its cost out so callers' totals include it —
      // see the note on labelMenuCandidates.
      labelUsage = result.usage;
    } catch {
      labeled = deduped.map((r) => ({
        ref: `${r.type}|${r.ref}`,
        label: r.hint || 'Menu',
        isDistinctMenu: true,
        isDrinkOnly: false,
        duplicateOf: null,
      }));
    }

    type Judged = { raw: Raw; verdict: LabeledCandidate; index: number };
    const judged: Judged[] = deduped.map((r, i) => {
      const key = `${r.type}|${r.ref}`;
      const verdict = labeled.find((l) => l.ref === key) ?? labeled[i];
      return {
        raw: r,
        index: i,
        verdict: verdict ?? { ref: key, label: r.hint || 'Menu', isDistinctMenu: true, isDrinkOnly: false, duplicateOf: null },
      };
    });

    // Drop drink-only menus outright, and non-menu links (nav/about/etc.).
    // Text and PDF candidates survive a false isDistinctMenu verdict — they are
    // rarely false positives, and dropping them could strip the only real menu.
    // Content-validated subpages (deepDiscoverRaw already confirmed their OWN
    // text looks like a menu, not just a guess from a generic link label like
    // "Menus") get the same protection — the labeler has no page content to
    // judge distinctness from, so its "not distinct" guess is the weaker signal.
    // A sub-page whose own URL or link text says "menu" is a menu source, and
    // the labeler is guessing without ever seeing the page. neni-amsterdam.nl
    // failed exactly here: /menus was discovered correctly, judged "not
    // distinct", dropped, and the restaurant fell back to homepage nav text and
    // came out with no dishes. Losing a real menu is worse than showing one
    // option too many (founder's priority ①).
    const namedLikeAMenu = (r: Raw): boolean =>
      r.type === 'subpage' && /\bmenus?\b|menukaart|speisekarte|carte/i.test(`${r.hint} ${hintFromUrl(r.ref)}`);

    const kept = judged.filter(
      (j) =>
        !j.verdict.isDrinkOnly &&
        // Non-food menus are dropped even for text/pdf (checked against the AI's
        // label too, in case the raw hint was opaque) — overrides the survival rule.
        !isNonFoodMenu(`${j.verdict.label} ${j.raw.hint} ${hintFromUrl(j.raw.ref)}`) &&
        (j.verdict.isDistinctMenu ||
          j.raw.type === 'text' ||
          j.raw.type === 'pdf' ||
          j.raw.contentValidated ||
          namedLikeAMenu(j.raw))
    );

    // Resolve duplicate groups (same menu in several formats) via duplicateOf
    // pointers; keep the preferred format from each group.
    const groupOf = new Map<number, number>(); // index → group root
    for (const j of judged) {
      const dup = j.verdict.duplicateOf;
      if (dup !== null && dup < j.index) {
        groupOf.set(j.index, groupOf.get(dup) ?? dup);
      } else if (!groupOf.has(j.index)) {
        groupOf.set(j.index, j.index);
      }
    }
    const groups = new Map<number, Judged[]>();
    for (const j of kept) {
      const root = groupOf.get(j.index) ?? j.index;
      groups.set(root, [...(groups.get(root) ?? []), j]);
    }

    const representatives: Judged[] = [];
    for (const members of Array.from(groups.values())) {
      members.sort((a, b) => FORMAT_PREFERENCE[a.raw.type] - FORMAT_PREFERENCE[b.raw.type] || a.index - b.index);
      representatives.push(members[0]);
    }
    representatives.sort((a, b) => a.index - b.index);

    // Label collisions: distinct sources the labeler failed to distinguish
    // (e.g. four hash-named PDFs all labeled "Menu") are kept but suffixed
    // ("Menu 2") — hiding a real menu is worse than a slightly awkward name.
    // True duplicates were already collapsed via duplicateOf above.
    const labelCount = new Map<string, number>();
    const unique: Array<{ j: Judged; label: string }> = [];
    for (const j of representatives) {
      // The homepage's own text is pinned to the neutral "Menu" — never the
      // labeler's guess. It is the one candidate the model sees with no URL and
      // no hint, so anything it returns is invention, and the site has no name
      // for this "menu" to be wrong about. Matches the zero-candidate fallbacks
      // below, which already use "Menu".
      const base = isHomepageText(j.raw) ? 'Menu' : j.verdict.label || j.raw.hint || 'Menu';
      const norm = base.toLowerCase().replace(/\s+/g, ' ').trim();
      const n = (labelCount.get(norm) ?? 0) + 1;
      labelCount.set(norm, n);
      unique.push({ j, label: n === 1 ? base : `${base} ${n}` });
    }
    finalCandidates = unique
      .slice(0, MAX_PICKER_CANDIDATES)
      .map(({ j, label }) => toCandidate(j.raw, label, j.verdict.description));

    // De-dupe by id (defensive against hash collisions).
    const byId = new Map<string, MenuCandidate>();
    for (const c of finalCandidates) if (!byId.has(c.id)) byId.set(c.id, c);
    finalCandidates = Array.from(byId.values());
  }

  // Guarantee at least one candidate when any content exists, so the
  // single-menu path always has something to extract. Only here — when no
  // text/PDF/subpage menu was found — do images become the candidate
  // (image-only sites, e.g. Squarespace menu boards).
  if (finalCandidates.length === 0) {
    const firstImage = (scrape.menuImages ?? [])[0];
    if (firstImage) {
      finalCandidates.push({ id: candidateId('image', firstImage), label: 'Menu', type: 'image', ref: firstImage, source: 'homepage' });
    } else if (inlineText.length >= 100) {
      finalCandidates.push({ id: candidateId('text', ''), label: 'Menu', type: 'text', ref: '', source: 'homepage' });
    } else if (scrape.screenshotUrl) {
      finalCandidates.push({ id: candidateId('image', scrape.screenshotUrl), label: 'Menu', type: 'image', ref: scrape.screenshotUrl, source: 'homepage' });
    }
  }

  return {
    candidates: finalCandidates,
    inlineText,
    restaurantTitle: scrape.title,
    finalUrl,
    screenshotUrl: scrape.screenshotUrl,
    usage: labelUsage,
  };
}
