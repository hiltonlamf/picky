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

/** Lazily scrape a sub-page and classify whichever source it yields. */
async function extractSubpage(url: string, title?: string, model?: string): Promise<Extraction> {
  try {
    const sub = await scrapeRestaurant(url);
    if (sub.menuText && sub.menuText.length >= 100) {
      return classifyMenuWithAI(sub.menuText, title ?? sub.title, model);
    }
    if (sub.menuPdfUrls && sub.menuPdfUrls.length > 0) {
      return classifyMenuFromPdf(sub.menuPdfUrls[0], title ?? sub.title, model);
    }
    if (sub.menuImages && sub.menuImages.length > 0) {
      return classifyMenuFromImages(sub.menuImages, title ?? sub.title, model);
    }
    if (sub.screenshotUrl) {
      return classifyMenuFromScreenshot(sub.screenshotUrl, title ?? sub.title, model);
    }
    return null;
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
      // Include sibling page images for better context.
      return classifyMenuFromImages(
        Array.from(new Set([candidate.ref, ...(ctx.imageUrls ?? [])])).slice(0, 4),
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
export async function extractMenu(candidate: MenuCandidate, ctx: ExtractContext): Promise<Extraction> {
  let best: Extraction = await runPrimary(candidate, ctx);
  let usage = best?.usage;
  if (isValid(best)) return best ? { menu: best.menu, usage: usage! } : null;

  // Alternate sources not already tried, in priority order.
  const altAttempts: Array<() => Promise<Extraction>> = [];
  if (candidate.type !== 'pdf' && ctx.pdfUrls?.length) {
    altAttempts.push(() => classifyMenuFromPdf(ctx.pdfUrls![0], ctx.title));
  }
  if (candidate.type !== 'image' && ctx.imageUrls?.length) {
    altAttempts.push(() => classifyMenuFromImages(ctx.imageUrls!.slice(0, 4), ctx.title));
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

/** Merge several labeled menus into one, prefixing sections and de-duping dishes. */
export function mergeMenus(named: Array<{ label: string; menu: ClassifiedMenu }>): ClassifiedMenu {
  const sections: RawSection[] = [];
  // Track best (highest-confidence) instance of each dish across all menus.
  const seen = new Map<string, number>(); // key → confidence kept

  const multi = named.length > 1;
  let restaurantName: string | undefined;
  let language: string | undefined;

  for (const { label, menu } of named) {
    restaurantName = restaurantName ?? menu.restaurantName;
    language = language ?? menu.language;
    for (const section of menu.sections) {
      const name = multi ? `${label} — ${section.name}` : section.name;
      const dishes = section.dishes.filter((d) => {
        const key = `${normName(d.name)}|${(d.price ?? '').toLowerCase()}`;
        const prev = seen.get(key);
        if (prev !== undefined && prev >= d.confidence) return false; // keep higher-confidence one
        seen.set(key, d.confidence);
        return true;
      });
      if (dishes.length > 0) sections.push({ name, dishes });
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
