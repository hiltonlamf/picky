import type { ClassifiedMenu, MenuCandidate, RawSection } from '@/types';
import {
  AIUsage,
  classifyMenuWithAI,
  classifyMenuFromPdf,
  classifyMenuFromImages,
  classifyMenuFromScreenshot,
  countFoodItems,
  ESCALATION_MODEL,
} from './ai';
import { scrapeRestaurant } from './scraper';
import { fetchScreenshot } from './reader';

export const MIN_FOOD_ITEMS = 7;

/** Context shared across a discovery result — alternate sources for retry. */
export interface ExtractContext {
  title?: string;
  inlineText?: string;
  screenshotUrl?: string;
  pdfUrls?: string[];
  imageUrls?: string[];
  pageUrl?: string; // the menu page URL — used to fetch a screenshot as last resort
}

type Extraction = { menu: ClassifiedMenu; usage: AIUsage } | null;

const HEADER_ITEM_RE =
  /\b(menu|selection|set\s*menu|set\s*lunch|set\s*dinner|tasting|à la carte|a la carte|platter|board|sample)\b/i;

/** True when extracted "dishes" look like section headers rather than real items. */
export function looksLikeHeaderItems(menu: ClassifiedMenu): boolean {
  const dishes = menu.sections.flatMap((s) => s.dishes);
  if (dishes.length === 0) return true;
  const headerish = dishes.filter(
    (d) => HEADER_ITEM_RE.test(d.name) && !d.price && !d.description
  ).length;
  return headerish / dishes.length > 0.3;
}

function isValid(extraction: Extraction): boolean {
  if (!extraction) return false;
  return countFoodItems(extraction.menu) >= MIN_FOOD_ITEMS && !looksLikeHeaderItems(extraction.menu);
}

function sumUsage(a: AIUsage | undefined, b: AIUsage | undefined): AIUsage {
  const base = a ?? { model: '', tokensIn: 0, tokensOut: 0, costUsd: 0 };
  if (!b) return base;
  return {
    model: a ? `${a.model}+${b.model}` : b.model,
    tokensIn: base.tokensIn + b.tokensIn,
    tokensOut: base.tokensOut + b.tokensOut,
    costUsd: base.costUsd + b.costUsd,
  };
}

/**
 * Lazily scrape a sub-page and classify whichever source it yields. Tries each
 * available source in order and keeps the best — a nav-heavy page whose TEXT
 * is just venue blurb must still fall through to its PDF/images/screenshot.
 */
async function extractSubpage(url: string, title?: string, model?: string): Promise<Extraction> {
  try {
    const sub = await scrapeRestaurant(url);
    const t = title ?? sub.title;

    const attempts: Array<() => Promise<Extraction>> = [];
    if (sub.menuText && sub.menuText.length >= 100) {
      attempts.push(() => classifyMenuWithAI(sub.menuText, t, model));
    }
    if (sub.menuPdfUrls && sub.menuPdfUrls.length > 0) {
      attempts.push(() => classifyMenuFromPdf(sub.menuPdfUrls![0], t, model));
    }
    if (sub.menuImages && sub.menuImages.length > 0) {
      attempts.push(() => classifyMenuFromImages(sub.menuImages!.slice(0, 6), t, model));
    }
    if (sub.screenshotUrl) {
      attempts.push(() => classifyMenuFromScreenshot(sub.screenshotUrl!, t, model));
    }

    let best: Extraction = null;
    let usage: AIUsage | undefined;
    for (const attempt of attempts) {
      const res = await attempt().catch(() => null);
      usage = sumUsage(usage, res?.usage);
      if (res && (!best || countFoodItems(res.menu) > countFoodItems(best.menu))) best = res;
      if (isValid(res)) break;
    }
    return best ? { menu: best.menu, usage: usage! } : null;
  } catch {
    return null;
  }
}

async function runPrimary(candidate: MenuCandidate, ctx: ExtractContext, model?: string): Promise<Extraction> {
  const title = ctx.title;
  switch (candidate.type) {
    case 'text':
      if (!ctx.inlineText || ctx.inlineText.length < 100) return null;
      return classifyMenuWithAI(ctx.inlineText, title, model);
    case 'pdf':
      return classifyMenuFromPdf(candidate.ref, title, model);
    case 'image':
      // Include sibling page images — menu boards are often split across
      // several photos and the food menu may not be the first image.
      return classifyMenuFromImages(
        Array.from(new Set([candidate.ref, ...(ctx.imageUrls ?? [])])).slice(0, 6),
        title,
        model
      );
    case 'subpage':
      return extractSubpage(candidate.ref, title, model);
    default:
      return null;
  }
}

/**
 * Extract one menu candidate with reliability-first validation + retry:
 * primary source → alternate sources (pdf/image/screenshot) → Opus escalation.
 * Returns the attempt with the most food items, with summed usage/cost.
 */
/** API-billing failures must surface as such — retrying other sources just
 *  burns more calls and ends in a misleading "couldn't read the menu". */
function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /credit balance|billing|purchase credits/i.test(msg);
}

export async function extractMenu(candidate: MenuCandidate, ctx: ExtractContext): Promise<Extraction> {
  // A hard failure (e.g. truncated/invalid JSON) must fall through to the
  // retry chain, not abort the whole extraction — except billing errors.
  let best: Extraction = null;
  try {
    best = await runPrimary(candidate, ctx);
  } catch (err) {
    if (isBillingError(err)) {
      throw new Error('Our AI service is temporarily unavailable. Please try again later.');
    }
  }
  let usage = best?.usage;
  if (isValid(best)) return best ? { menu: best.menu, usage: usage! } : null;

  // Alternate sources not already tried, in priority order.
  const altAttempts: Array<() => Promise<Extraction>> = [];
  if (candidate.type !== 'pdf' && ctx.pdfUrls?.length) {
    altAttempts.push(() => classifyMenuFromPdf(ctx.pdfUrls![0], ctx.title));
  }
  if (candidate.type !== 'image' && ctx.imageUrls?.length) {
    altAttempts.push(() => classifyMenuFromImages(ctx.imageUrls!.slice(0, 6), ctx.title));
  }
  if (ctx.screenshotUrl) {
    altAttempts.push(() => classifyMenuFromScreenshot(ctx.screenshotUrl!, ctx.title));
  }

  for (const attempt of altAttempts) {
    const res = await attempt().catch(() => null);
    usage = sumUsage(usage, res?.usage);
    if (res && (!best || countFoodItems(res.menu) > countFoodItems(best.menu))) best = res;
    if (isValid(res)) break;
  }

  // Universal vision fallback: render the page to a full-page screenshot and
  // read it. Catches image-only menus and JS-embedded/canvas menus that yield
  // no usable text, PDF, or discrete images (works on Jina's keyless tier).
  if (!isValid(best)) {
    // Screenshot the candidate's own page when it's a sub-page; otherwise the
    // menu page we landed on.
    const shotUrl = candidate.type === 'subpage' && candidate.ref ? candidate.ref : ctx.pageUrl;
    const shot = ctx.screenshotUrl ?? (shotUrl ? await fetchScreenshot(shotUrl).catch(() => null) : null);
    if (shot) {
      const res = await classifyMenuFromScreenshot(shot, ctx.title).catch(() => null);
      usage = sumUsage(usage, res?.usage);
      if (res && (!best || countFoodItems(res.menu) > countFoodItems(best.menu))) best = res;
    }
  }

  // Last resort: escalate the original source to the strongest model.
  if (!isValid(best)) {
    const escalated = await runPrimary(candidate, ctx, ESCALATION_MODEL).catch(() => null);
    usage = sumUsage(usage, escalated?.usage);
    if (escalated && (!best || countFoodItems(escalated.menu) > countFoodItems(best.menu))) best = escalated;
  }

  return best ? { menu: best.menu, usage: usage! } : null;
}

function normName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * Merge several labeled menus into one, tagging each section with its source
 * menu (menuLabel) so the UI can present one menu at a time.
 *
 * Dishes are de-duped only WITHIN a menu: a dish on both Lunch and Dinner must
 * still appear when the user views either menu, so cross-menu de-dup would be
 * wrong. Single-menu results carry no menuLabel and render as before.
 */
export function mergeMenus(named: Array<{ label: string; menu: ClassifiedMenu }>): ClassifiedMenu {
  const multi = named.length > 1;
  let restaurantName: string | undefined;
  let language: string | undefined;

  const dishKey = (label: string, d: { name: string; price?: string }) =>
    `${label.toLowerCase()}|${normName(d.name)}|${(d.price ?? '').toLowerCase()}`;

  // Pass 1: best confidence per dish within each menu.
  const best = new Map<string, number>();
  for (const { label, menu } of named) {
    for (const section of menu.sections) {
      for (const d of section.dishes) {
        const key = dishKey(label, d);
        if ((best.get(key) ?? -1) < d.confidence) best.set(key, d.confidence);
      }
    }
  }

  // Pass 2: keep exactly one instance per key — the first with best confidence.
  const taken = new Set<string>();
  const sections: RawSection[] = [];
  for (const { label, menu } of named) {
    restaurantName = restaurantName ?? menu.restaurantName;
    language = language ?? menu.language;
    for (const section of menu.sections) {
      const dishes = section.dishes.filter((d) => {
        const key = dishKey(label, d);
        if (taken.has(key) || d.confidence < (best.get(key) ?? 0)) return false;
        taken.add(key);
        return true;
      });
      if (dishes.length > 0) sections.push({ name: section.name, dishes, menuLabel: multi ? label : null });
    }
  }

  return { restaurantName, language, sections };
}

/** Extract every selected candidate (bounded) and merge into a single menu. */
export async function extractAndMerge(
  candidates: MenuCandidate[],
  ctx: ExtractContext
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  const results = await Promise.all(
    candidates.map(async (c) => ({ label: c.label, res: await extractMenu(c, ctx) }))
  );

  const named = results
    .filter((r) => r.res && r.res.menu.sections.length > 0)
    .map((r) => ({ label: r.label, menu: r.res!.menu }));

  let usage: AIUsage | undefined;
  for (const r of results) usage = sumUsage(usage, r.res?.usage);

  if (named.length === 0) {
    throw new Error(
      "We found the menu but couldn't read the dishes clearly. Try pasting a direct link to the menu page or a clearer menu source."
    );
  }

  const menu = mergeMenus(named);
  return {
    menu,
    usage: usage ?? { model: EXTRACTION_USAGE_FALLBACK, tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

const EXTRACTION_USAGE_FALLBACK = 'unknown';
