import type { ClassifiedMenu, MenuCandidate, RawSection } from '@/types';
import {
  AICallError,
  AIUsage,
  MenuAccessBlockedError,
  classifyMenuWithAI,
  classifyMenuFromPdf,
  classifyMenuFromImages,
  classifyMenuFromScreenshot,
  countFoodItems,
  isBillingError,
  verifyVegClassifications,
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
  /** Live status callback — long analyses stream these to the user so a slow
   *  extraction doesn't look like a frozen app. */
  onProgress?: (message: string) => void;
}

type Extraction = { menu: ClassifiedMenu; usage: AIUsage } | null;

/**
 * "No menu found" failure that still carries what the failed attempts COST.
 * Failed retry ladders are the most expensive path in the pipeline (every rung
 * is a full-price AI call), so losing their usage made spend reports blind to
 * the worst spenders — callers must record `usage` before surfacing the error.
 */
export class ExtractionError extends Error {
  usage?: AIUsage;
  /** The menu exists but we were refused access — a limitation of ours, not a
   *  fact about the restaurant. Drives different, honest user-facing copy. */
  blocked: boolean;
  constructor(message: string, usage?: AIUsage, blocked = false) {
    super(message);
    this.name = 'ExtractionError';
    this.usage = usage;
    this.blocked = blocked;
  }
}

/**
 * Shown when a menu is there and a person could open it, but we could not.
 * Founder's wording (2026-08-05): be straight about the limitation being ours
 * and ask for a hand, rather than implying the restaurant has no menu.
 */
export const BLOCKED_MENU_MESSAGE =
  'Some things on the web are off-limits to AI agents: either we cannot read them, or we are not ' +
  'permitted to. This menu is one of those — a person can open it, but we get turned away. ' +
  "Can you give us a hand by uploading the menu, or pasting a direct link? We'll read it right away.";

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

export function sumUsage(a: AIUsage | undefined, b: AIUsage | undefined): AIUsage {
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
      const { result, usage: spent } = await attemptOrNull(attempt);
      usage = sumUsage(usage, spent);
      if (result && (!best || countFoodItems(result.menu) > countFoodItems(best.menu))) best = result;
      if (isValid(result)) break;
    }
    if (best) return { menu: best.menu, usage: usage! };
    // Nothing usable — but this sub-page may have burned several calls getting
    // there. Surface the spend instead of returning a bare null that loses it.
    if (usage && usage.costUsd > 0) {
      throw new AICallError(`No menu found on ${url}`, usage);
    }
    return null;
  } catch (err) {
    if (isBillingError(err)) throw err;
    if (err instanceof AICallError) throw err;
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
 * primary source → alternate sources (pdf/image/screenshot) → Sonnet escalation.
 * Returns the attempt with the most food items, with summed usage/cost.
 */
/**
 * Run one extraction attempt: hard failures (e.g. truncated JSON) become null
 * so the retry chain continues — except API-billing failures, which must
 * surface as such; retrying other sources just burns more calls and ends in a
 * misleading "couldn't read the menu".
 */
type Attempt = { result: Extraction; usage?: AIUsage; blocked?: boolean };

async function attemptOrNull(fn: () => Promise<Extraction>): Promise<Attempt> {
  try {
    const result = await fn();
    return { result, usage: result?.usage };
  } catch (err) {
    if (isBillingError(err)) {
      // Keep the underlying cause in server logs; users get the generic line.
      console.error('[extract] API access error:', err instanceof Error ? err.message : err);
      throw new Error('Our AI service is temporarily unavailable. Please try again later.');
    }
    // A call that reached Anthropic was billed even though we can't use its
    // output. Carrying its usage out is the difference between a rung of the
    // retry ladder costing $0.02 and appearing to cost nothing — the undercount
    // that made three of six restaurants report "$0.0000 spent" in run #33.
    if (err instanceof AICallError) {
      console.error('[extract] unusable AI response:', err.message);
      return { result: null, usage: err.usage };
    }
    if (err instanceof MenuAccessBlockedError) {
      console.error('[extract] menu exists but access was refused:', err.detail);
      return { result: null, blocked: true };
    }
    return { result: null };
  }
}

/** Human phrasing for the start of a candidate's extraction. */
function startMessage(candidate: MenuCandidate): string {
  switch (candidate.type) {
    case 'pdf':
      return `Reading the ${candidate.label} PDF...`;
    case 'image':
      return 'Found the menu in an image — scanning it for dishes...';
    case 'subpage':
      return `Opening the ${candidate.label} page...`;
    default:
      return 'Reading the menu text...';
  }
}

/** The ordered retry chain for one candidate. Static so extraction can be
 *  resumed from any attempt index in a later request (serverless time caps). */
function attemptPlan(candidate: MenuCandidate, ctx: ExtractContext): Array<{ note: string; run: () => Promise<Extraction> }> {
  const plan: Array<{ note: string; run: () => Promise<Extraction> }> = [
    { note: startMessage(candidate), run: () => runPrimary(candidate, ctx) },
  ];
  if (candidate.type !== 'pdf' && ctx.pdfUrls?.length) {
    plan.push({
      note: 'That source was unclear — reading the menu PDF instead...',
      run: () => classifyMenuFromPdf(ctx.pdfUrls![0], ctx.title),
    });
  }
  if (candidate.type !== 'image' && ctx.imageUrls?.length) {
    plan.push({
      note: 'Scanning the menu images for dishes...',
      run: () => classifyMenuFromImages(ctx.imageUrls!.slice(0, 6), ctx.title),
    });
  }
  // Universal vision fallback: read a full-page screenshot (existing one, or
  // rendered on demand). Catches image-only and JS/canvas menus.
  plan.push({
    note: 'Taking a snapshot of the page to read it visually...',
    run: async () => {
      const shotUrl = candidate.type === 'subpage' && candidate.ref ? candidate.ref : ctx.pageUrl;
      const shot = ctx.screenshotUrl ?? (shotUrl ? await fetchScreenshot(shotUrl).catch(() => null) : null);
      return shot ? classifyMenuFromScreenshot(shot, ctx.title) : null;
    },
  });
  // Last resort: escalate the original source to the strongest model.
  plan.push({
    note: 'Double-checking with our strongest AI model...',
    run: () => runPrimary(candidate, ctx, ESCALATION_MODEL),
  });
  return plan;
}

export interface ResumableResult {
  best: Extraction;
  usage?: AIUsage;
  /** Attempt index to resume from, or null when the chain is finished. */
  nextIndex: number | null;
  /** A source existed but refused us — see ExtractionError.blocked. */
  blocked?: boolean;
}

/**
 * Run a candidate's retry chain starting at `startIndex`, stopping early when
 * a valid menu is found or `deadline` (ms epoch) approaches. Lets serverless
 * callers split one long extraction across several short requests.
 */
export async function extractMenuResumable(
  candidate: MenuCandidate,
  ctx: ExtractContext,
  startIndex = 0,
  deadline = Number.POSITIVE_INFINITY,
  carried: Extraction = null,
  carriedUsage?: AIUsage
): Promise<ResumableResult> {
  const progress = ctx.onProgress ?? (() => {});
  const plan = attemptPlan(candidate, ctx);
  let best: Extraction = carried;
  let usage: AIUsage | undefined = carriedUsage ?? carried?.usage;
  let blocked = false;

  for (let i = startIndex; i < plan.length; i++) {
    if (isValid(best)) break;
    if (Date.now() >= deadline) {
      return { best: best ? { menu: best.menu, usage: usage! } : null, usage, nextIndex: i, blocked };
    }
    progress(plan[i].note);
    const { result, usage: spent, blocked: refused } = await attemptOrNull(plan[i].run);
    usage = sumUsage(usage, spent);
    if (refused) blocked = true;
    if (result && (!best || countFoodItems(result.menu) > countFoodItems(best.menu))) best = result;
  }

  return { best: best ? { menu: best.menu, usage: usage! } : null, usage, nextIndex: null, blocked };
}

export async function extractMenu(candidate: MenuCandidate, ctx: ExtractContext): Promise<Extraction> {
  const { best } = await extractMenuResumable(candidate, ctx);
  return best;
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
 * wrong. Single-menu results carry no menuLabel and render as before — UNLESS
 * the extraction itself already split that one page into several distinctly-
 * named menus (SYSTEM_PROMPT's "multiple distinct named menus" rule, e.g. a
 * single page listing "À La Carte" / "Tasting Menu" / "Groups" back to back)
 * and tagged its own sections with a menuLabel — that per-section label is
 * preserved rather than overwritten, so a single discovered candidate can
 * still present as multiple separate menus in the UI.
 */
export function mergeMenus(named: Array<{ label: string; menu: ClassifiedMenu }>): ClassifiedMenu {
  const multi = named.length > 1;
  let restaurantName: string | undefined;
  let language: string | undefined;
  let cuisine: string | null | undefined;

  // The label a section actually ends up tagged with: the candidate's label
  // when several candidates were merged, otherwise whatever menuLabel the
  // extraction itself assigned that section (null for an ordinary single
  // menu). Dedup must key off THIS, not the outer candidate label — a single
  // candidate split into several named menus (see mergeMenus's doc comment)
  // can legitimately repeat a dish (e.g. a side) across two of them, and that
  // must survive the same way it would if they'd been separate candidates.
  const effectiveLabel = (candidateLabel: string, section: RawSection): string =>
    multi ? candidateLabel : (section.menuLabel ?? candidateLabel);

  const dishKey = (label: string, d: { name: string; price?: string }) =>
    `${label.toLowerCase()}|${normName(d.name)}|${(d.price ?? '').toLowerCase()}`;

  // Pass 1: best confidence per dish within each menu.
  const best = new Map<string, number>();
  for (const { label, menu } of named) {
    for (const section of menu.sections) {
      const key0 = effectiveLabel(label, section);
      for (const d of section.dishes) {
        const key = dishKey(key0, d);
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
    cuisine = cuisine ?? menu.cuisine;
    for (const section of menu.sections) {
      const sectionLabel = effectiveLabel(label, section);
      const dishes = section.dishes.filter((d) => {
        const key = dishKey(sectionLabel, d);
        if (taken.has(key) || d.confidence < (best.get(key) ?? 0)) return false;
        taken.add(key);
        return true;
      });
      if (dishes.length > 0) {
        sections.push({ name: section.name, dishes, menuLabel: multi ? label : (section.menuLabel ?? null) });
      }
    }
  }

  return { restaurantName, language, cuisine, sections };
}

/** Extract every selected candidate (bounded) and merge into a single menu. */
export async function extractAndMerge(
  candidates: MenuCandidate[],
  ctx: ExtractContext
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  const results = await Promise.all(
    candidates.map(async (c) => {
      const r = await extractMenuResumable(c, ctx);
      // Take `r.usage`, not `r.best.usage`: when every rung of the ladder fails,
      // `best` is null — a shape that cannot carry usage — and reading spend off
      // it discards calls Anthropic already billed. That is precisely the
      // structural undercount CLAUDE.md records from 2026-07-25, and it was
      // still live here: run #40 spent three real calls on Tofu Vegan and
      // reported "$0.0000". `r.usage` is the accumulated total across every
      // attempt, so it is also the more complete number on success.
      return { label: c.label, res: r.best, usage: r.usage, blocked: r.blocked === true };
    })
  );

  const named = results
    .filter((r) => r.res && r.res.menu.sections.length > 0)
    .map((r) => ({ label: r.label, menu: r.res!.menu }));

  if (named.length > 1) ctx.onProgress?.('Combining the menus and classifying every dish...');

  let usage: AIUsage | undefined;
  for (const r of results) usage = sumUsage(usage, r.usage);

  if (named.length === 0) {
    // Every source (text, PDF, images, screenshot, escalation) came back with
    // nothing — either the menu is unreadable or the site doesn't really have
    // one. Be honest about both possibilities — and carry the cost of all
    // those failed attempts so it lands in the spend accounting.
    // A menu we were REFUSED is not a restaurant without a menu. Saying the
    // latter would be false, and it would put the blame in the wrong place.
    const wasBlocked = results.some((r) => r.blocked);
    throw new ExtractionError(
      wasBlocked
        ? BLOCKED_MENU_MESSAGE
        : "We couldn't read a food menu on this website — it may not publish one online. If it does, paste a direct link to the menu page and we'll try again.",
      usage,
      wasBlocked
    );
  }

  const merged = mergeMenus(named);

  // Strong-model audit of the veg/vegan labels users actually filter by —
  // the guardrail that makes cheap Haiku extraction safe.
  ctx.onProgress?.('Double-checking the vegetarian and vegan labels...');
  const verified = await verifyVegClassifications(merged, ctx.title);
  usage = sumUsage(usage, verified.usage);

  return {
    menu: verified.menu,
    usage: usage ?? { model: EXTRACTION_USAGE_FALLBACK, tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

const EXTRACTION_USAGE_FALLBACK = 'unknown';
