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
  VERIFY_VEG_ENABLED,
  ESCALATION_MODEL,
} from './ai';
import { scrapeRestaurant } from './scraper';
import { fetchScreenshot } from './reader';
// Reused rather than re-implemented: the same price-density heuristic discovery
// already uses to tell a menu from a cookie banner. Pure and free (no AI).
import { textLooksLikeMenu } from './menu-discovery';

export const MIN_FOOD_ITEMS = 7;

/** Context shared across a discovery result — alternate sources for retry. */
export interface ExtractContext {
  title?: string;
  inlineText?: string;
  screenshotUrl?: string;
  pdfUrls?: string[];
  imageUrls?: string[];
  pageUrl?: string; // the menu page URL — used to fetch a screenshot as last resort
  /**
   * PDFs already covered by their OWN independent `pdf`-type candidate in this
   * selection. A `subpage` candidate that turns out to have no real inline
   * text of its own (e.g. a page that just states lunch/dinner price tiers
   * and links a downloadable PDF) falls back to classifying that same PDF —
   * redundant, full-price work when the PDF is already being read on its own
   * merits as a separate candidate. Restaurant de Kas's PDF (page 1 = Lunch,
   * page 2 = Dinner) was read twice this way: once as its own `pdf`
   * candidate, once via the `/eng/menu` subpage's fallback — two independent
   * completions of the same document, which also meant the subpage's result
   * outscored the pdf candidate's own correct internal Lunch/Dinner
   * `menuLabel` tagging once mergeMenus saw 2 "named" menus instead of 1.
   * Both `attemptPlan`'s alternate-PDF rung and `extractSubpage`'s own
   * PDF fallback consult this list and skip anything already on it.
   */
  excludePdfUrls?: string[];
  /** Live status callback — long analyses stream these to the user so a slow
   *  extraction doesn't look like a frozen app. */
  onProgress?: (message: string) => void;
  /**
   * Per-run memo for rungs whose input is SHARED across candidates (the same
   * alternate PDF, the same page images, the same screenshot). Without it, N
   * candidates that each fail their primary source each pay full price to
   * re-read byte-identical content — up to 6× the same call on a 6-candidate
   * site. Holds the in-flight promise, not just the settled value, so
   * concurrent candidates under Promise.all join the first call.
   */
  sharedAttempts?: Map<string, Promise<Attempt>>;
  /**
   * Sonnet escalations left for this whole run, shared by reference across
   * candidates. An object rather than a number so decrements are visible to
   * sibling candidates running concurrently.
   */
  escalationBudget?: { remaining: number };
  /** Set once any candidate produces a valid menu — see shouldEscalate use. */
  anyCandidateValid?: { value: boolean };
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
  "permitted to. Can you give us a hand by uploading the menu, or pasting a direct link? We'll " +
  'read it right away.';

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

/**
 * `gated` (default) applies shouldEscalate; `always` restores the pre-2026-08-08
 * behaviour of escalating every exhausted ladder; `off` is an emergency brake.
 * An env switch so either can be done without a deploy.
 */
export const MENU_ESCALATION_MODE = (process.env.MENU_ESCALATION_MODE ?? 'gated') as
  | 'gated'
  | 'always'
  | 'off';

/** Sonnet escalations allowed per extraction run, across ALL candidates. */
export const DEFAULT_ESCALATION_BUDGET = 2;

/** What the earlier rungs proved about this candidate. */
export interface EscalationEvidence {
  /** A source existed but refused us (403, Drive view-only, robots block). */
  blocked: boolean;
  /** At least one rung actually reached the API and was billed. */
  anyBilled: boolean;
  /** A billed rung came back malformed (invalid JSON / truncated), not empty. */
  anyMalfunction: boolean;
  /** A PDF / image / screenshot rung was billed — real visual content was read. */
  visualBilled: boolean;
  /** Most food items any rung found so far. */
  bestItems: number;
  /** The primary source is text that reads like a real menu (price density). */
  menuLikeInput: boolean;
}

/**
 * Should we pay for the strongest model to re-read this candidate?
 *
 * Escalation re-runs the SAME source on Sonnet, so it can only help when there
 * was something to read. Measured over 2026-07-25..08-08: the rung was 46% of
 * all spend and 75% of its calls returned <100 output tokens — an empty
 * `{"sections":[]}` produced by re-reading a page that had no menu text on it
 * (menu behind a popup/JS, or the site refused us). Those cases are structural
 * dead ends: a pricier model cannot read text that never loaded.
 *
 * It genuinely does rescue the opposite case — De Kas, Chez Max, Vintage
 * Kitchen, Kicky's: multilingual or multi-menu pages where the text WAS there
 * and Haiku parsed it badly. So the gate keeps every rung where content was
 * demonstrably retrieved, and skips only where nothing was.
 */
export function shouldEscalate(ev: EscalationEvidence): boolean {
  if (MENU_ESCALATION_MODE === 'off') return false;
  if (MENU_ESCALATION_MODE === 'always') return true;
  // Refused access, or nothing ever reached a model: the escalation would send
  // the same absent bytes to a pricier model. Provably lossless to skip.
  if (ev.blocked || !ev.anyBilled) return false;
  return (
    ev.bestItems >= 1 || // thin parse — the classic rescue
    ev.anyMalfunction || // broken output — a stronger model may recover it
    ev.menuLikeInput || // price-dense menu text that Haiku still read as empty
    ev.visualBilled // a PDF/photo was actually read; Sonnet vision beats Haiku
  );
}

export function sumUsage(a: AIUsage | undefined, b: AIUsage | undefined): AIUsage {
  const base = a ?? { model: '', tokensIn: 0, tokensOut: 0, costUsd: 0 };
  if (!b) return base;
  return {
    model: a ? `${a.model}+${b.model}` : b.model,
    tokensIn: base.tokensIn + b.tokensIn,
    tokensOut: base.tokensOut + b.tokensOut,
    costUsd: base.costUsd + b.costUsd,
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  };
}

/**
 * Lazily scrape a sub-page and classify whichever source it yields. Tries each
 * available source in order and keeps the best — a nav-heavy page whose TEXT
 * is just venue blurb must still fall through to its PDF/images/screenshot.
 */
async function extractSubpage(
  url: string,
  title?: string,
  model?: string,
  excludePdfUrls?: string[]
): Promise<Extraction> {
  try {
    const sub = await scrapeRestaurant(url);
    const t = title ?? sub.title;

    const attempts: Array<() => Promise<Extraction>> = [];
    if (sub.menuText && sub.menuText.length >= 100) {
      attempts.push(() => classifyMenuWithAI(sub.menuText, t, model));
    }
    // Skip a PDF this sub-page merely links to when that exact PDF already has
    // its own independent candidate — see ExtractContext.excludePdfUrls.
    const subPdfUrls = (sub.menuPdfUrls ?? []).filter((u) => !excludePdfUrls?.includes(u));
    if (subPdfUrls.length > 0) {
      attempts.push(() => classifyMenuFromPdf(subPdfUrls[0], t, model));
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
      // empty=true: every source on this sub-page was read and none held a
      // menu. Reporting it as a malfunction instead would wrongly signal
      // "the model broke, try a stronger one" to the escalation gate.
      throw new AICallError(`No menu found on ${url}`, usage, false, true);
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
      return extractSubpage(candidate.ref, title, model, ctx.excludePdfUrls);
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
export type Attempt = {
  result: Extraction;
  usage?: AIUsage;
  blocked?: boolean;
  /** This rung actually reached the API and was billed. */
  billed?: boolean;
  /** A billed rung read the source and reported no menu in it (not a fault). */
  empty?: boolean;
  /** A billed rung came back malformed — invalid JSON or truncated output. */
  malfunction?: boolean;
};

async function attemptOrNull(fn: () => Promise<Extraction>): Promise<Attempt> {
  try {
    const result = await fn();
    // The text path reports "nothing here" by returning {sections: []}
    // SUCCESSFULLY rather than throwing, so emptiness has to be detected on
    // the happy path too — not just in the catch below.
    const empty = result != null && countFoodItems(result.menu) === 0;
    return { result, usage: result?.usage, billed: result?.usage != null, empty };
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
      // `empty` = the model read it and found no menu; anything else that
      // reached the API (invalid JSON, truncation) is a malfunction, which a
      // stronger model can plausibly recover from. That split is what decides
      // escalation — see shouldEscalate.
      return {
        result: null,
        usage: err.usage,
        billed: err.usage != null,
        empty: err.empty,
        malfunction: err.usage != null && !err.empty,
      };
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
type PlanRung = {
  note: string;
  run: () => Promise<Extraction>;
  /** Source class — drives `visualBilled` evidence and the share key. */
  kind: 'text' | 'doc' | 'image' | 'shot' | 'subpage';
  /** Rungs sharing a key across candidates are the same call; pay once. */
  shareKey?: string;
  /** The final strongest-model rung, gated by shouldEscalate. */
  escalation?: boolean;
};

function attemptPlan(candidate: MenuCandidate, ctx: ExtractContext): PlanRung[] {
  const primaryKind: PlanRung['kind'] =
    candidate.type === 'pdf'
      ? 'doc'
      : candidate.type === 'image'
        ? 'image'
        : candidate.type === 'subpage'
          ? 'subpage'
          : 'text';
  const plan: PlanRung[] = [
    { note: startMessage(candidate), run: () => runPrimary(candidate, ctx), kind: primaryKind },
  ];
  const altPdfUrls = (ctx.pdfUrls ?? []).filter((u) => !ctx.excludePdfUrls?.includes(u));
  if (candidate.type !== 'pdf' && altPdfUrls.length) {
    plan.push({
      note: 'That source was unclear — reading the menu PDF instead...',
      run: () => classifyMenuFromPdf(altPdfUrls[0], ctx.title),
      kind: 'doc',
      shareKey: `pdf:${altPdfUrls[0]}`,
    });
  }
  if (candidate.type !== 'image' && ctx.imageUrls?.length) {
    const images = ctx.imageUrls.slice(0, 6);
    plan.push({
      note: 'Scanning the menu images for dishes...',
      run: () => classifyMenuFromImages(images, ctx.title),
      kind: 'image',
      shareKey: `images:${images.join('|')}`,
    });
  }
  // Universal vision fallback: read a full-page screenshot (existing one, or
  // rendered on demand). Catches image-only and JS/canvas menus.
  const shotUrl = candidate.type === 'subpage' && candidate.ref ? candidate.ref : ctx.pageUrl;
  plan.push({
    note: 'Taking a snapshot of the page to read it visually...',
    run: async () => {
      const shot = ctx.screenshotUrl ?? (shotUrl ? await fetchScreenshot(shotUrl).catch(() => null) : null);
      return shot ? classifyMenuFromScreenshot(shot, ctx.title) : null;
    },
    kind: 'shot',
    // Key on the effective image so two candidates pointing at the same page
    // share one screenshot read (fetchScreenshot is itself a paid call in some
    // reader configurations). A subpage keys on its own ref, so a genuinely
    // different page still gets its own.
    shareKey: ctx.screenshotUrl ? `shot:${ctx.screenshotUrl}` : shotUrl ? `shot:${shotUrl}` : undefined,
  });
  // Last resort: escalate the original source to the strongest model.
  plan.push({
    note: 'Double-checking with our strongest AI model...',
    run: () => runPrimary(candidate, ctx, ESCALATION_MODEL),
    kind: primaryKind,
    escalation: true,
  });
  return plan;
}

/**
 * Run one rung, joining an identical in-flight/settled call from a sibling
 * candidate when the rung's input is shared.
 *
 * The replay is handed a usage-STRIPPED copy on purpose: only one call was
 * made, so only the first consumer may book its cost. This is the single place
 * where CLAUDE.md's "never drop usage" rule inverts into "never double-count
 * usage" — counting it per consumer would inflate the ledger we make spend
 * decisions from.
 */
async function runRung(rung: PlanRung, ctx: ExtractContext): Promise<Attempt> {
  if (!rung.shareKey || !ctx.sharedAttempts) return attemptOrNull(rung.run);
  const inFlight = ctx.sharedAttempts.get(rung.shareKey);
  if (inFlight) {
    const first = await inFlight;
    console.error(`[extract] shared-rung reuse (no second call): ${rung.shareKey}`);
    return { ...first, usage: undefined, billed: false };
  }
  // Registered synchronously (attemptOrNull returns its promise before any
  // await resolves), so a concurrent sibling sees it rather than racing.
  const started = attemptOrNull(rung.run);
  ctx.sharedAttempts.set(rung.shareKey, started);
  return started;
}

export interface ResumableResult {
  best: Extraction;
  usage?: AIUsage;
  /** Attempt index to resume from, or null when the chain is finished. */
  nextIndex: number | null;
  /** A source existed but refused us — see ExtractionError.blocked. */
  blocked?: boolean;
  /**
   * What the rungs run so far proved. MUST be persisted and passed back on a
   * resumed request: a candidate that resumes straight onto the escalation rung
   * with a blank record would look like "nothing was ever billed" and get
   * skipped for the wrong reason.
   */
  evidence?: EscalationEvidence;
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
  carriedUsage?: AIUsage,
  carriedEvidence?: EscalationEvidence
): Promise<ResumableResult> {
  const progress = ctx.onProgress ?? (() => {});
  const plan = attemptPlan(candidate, ctx);
  let best: Extraction = carried;
  let usage: AIUsage | undefined = carriedUsage ?? carried?.usage;
  let blocked = carriedEvidence?.blocked ?? false;

  const evidence: EscalationEvidence = carriedEvidence ?? {
    blocked: false,
    anyBilled: false,
    anyMalfunction: false,
    visualBilled: false,
    bestItems: carried ? countFoodItems(carried.menu) : 0,
    // The page's own text, judged once. Reused for every candidate type: a
    // subpage sitting on a price-dense page is worth escalating even if this
    // candidate's own rungs came back empty.
    menuLikeInput: textLooksLikeMenu(ctx.inlineText ?? ''),
  };

  for (let i = startIndex; i < plan.length; i++) {
    if (isValid(best)) break;
    if (Date.now() >= deadline) {
      return { best: best ? { menu: best.menu, usage: usage! } : null, usage, nextIndex: i, blocked, evidence };
    }
    const rung = plan[i];

    if (rung.escalation) {
      const budget = ctx.escalationBudget;
      // A sibling already produced a valid menu and this candidate found
      // nothing: an empty candidate contributes nothing to mergeMenus, so
      // paying Sonnet to confirm its emptiness cannot change what users see.
      // A thin-but-nonzero sibling still escalates (multi-menu restaurants).
      const siblingCovered = ctx.anyCandidateValid?.value === true && evidence.bestItems === 0;
      const budgetSpent = budget != null && budget.remaining <= 0;
      const allowed = shouldEscalate(evidence) && !siblingCovered && !budgetSpent;
      if (!allowed) {
        const reason = evidence.blocked
          ? 'blocked'
          : !evidence.anyBilled
            ? 'nothing-billed'
            : budgetSpent
              ? 'budget-exhausted'
              : siblingCovered
                ? 'sibling-already-valid'
                : 'read-and-empty';
        console.error(
          `[escalate] candidate=${candidate.type} decision=skip reason=${reason} bestItems=${evidence.bestItems}`
        );
        continue;
      }
      if (budget) budget.remaining -= 1;
      console.error(
        `[escalate] candidate=${candidate.type} decision=run bestItems=${evidence.bestItems} ` +
          `malfunction=${evidence.anyMalfunction} visual=${evidence.visualBilled} menuLike=${evidence.menuLikeInput}`
      );
    }

    progress(rung.note);
    const attempt = await runRung(rung, ctx);
    usage = sumUsage(usage, attempt.usage);
    if (attempt.blocked) {
      blocked = true;
      evidence.blocked = true;
    }
    if (attempt.billed) {
      evidence.anyBilled = true;
      if (attempt.malfunction) evidence.anyMalfunction = true;
      // 'subpage' counts as visual on purpose. extractSubpage runs its own
      // internal text→PDF→images→screenshot ladder, and from out here we can't
      // see which of those it billed — and subpages are exactly where the
      // multi-menu PDFs live (De Kas's /eng/menu: page 1 Lunch, page 2 Dinner).
      // Treating it as "content was read" keeps founder error type 2 covered.
      // This is the most generous clause in the gate; the [escalate] decision
      // log exists so it can be tightened against real data instead of a guess.
      if (rung.kind === 'doc' || rung.kind === 'image' || rung.kind === 'shot' || rung.kind === 'subpage') {
        evidence.visualBilled = true;
      }
    }
    if (attempt.result && (!best || countFoodItems(attempt.result.menu) > countFoodItems(best.menu))) {
      best = attempt.result;
    }
    evidence.bestItems = best ? countFoodItems(best.menu) : 0;
    if (isValid(best) && ctx.anyCandidateValid) ctx.anyCandidateValid.value = true;

    if (rung.escalation) {
      console.error(`[escalate] candidate=${candidate.type} outcome items=${evidence.bestItems}`);
    }
  }

  return { best: best ? { menu: best.menu, usage: usage! } : null, usage, nextIndex: null, blocked, evidence };
}

export async function extractMenu(candidate: MenuCandidate, ctx: ExtractContext): Promise<Extraction> {
  const { best } = await extractMenuResumable(candidate, ctx);
  return best;
}

function normName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/** Below this, two menus sharing a dish list is coincidence, not duplication
 *  (two three-item menus of soup/salad/bread prove nothing). */
const MIN_IDENTICAL_MENU_DISHES = 3;

/**
 * Which menu name survives when two menus turn out to hold the same dishes.
 * Lower tier wins.
 *
 * This is not cosmetic. An Early Bird is normally a time-restricted subset of
 * the à la carte, so when the two carry the SAME dishes, presenting them under
 * the Early Bird name would tell a diner those dishes are only available before
 * 7pm — a claim the restaurant never made. Keep the least-restricted name.
 */
// NOTE: the à-la-carte alternative sits OUTSIDE the \b(...)\b wrapper. In
// JavaScript \b is defined on ASCII word characters, so "à" is a non-word
// character and `\bà` can never match — "À La Carte" silently failed every
// tier check until a test caught it.
const MENU_LABEL_TIERS: RegExp[] = [
  /[àa]\s?la\s?carte|\b(main|dinner|evening|restaurant)\b/i,
  /\b(lunch|brunch|breakfast|sunday|weekend|seasonal|set|tasting)\b/i,
  /\b(early\s?bird|late\s?bird|pre[-\s]?theatre|pre[-\s]?theater)\b/i,
];

/** Generic, information-free names ("Menu", "Menus", "Menu 2") rank last. */
const GENERIC_MENU_LABEL_RE = /^\s*menus?(\s+\d+)?\s*$/i;

function menuLabelTier(label: string): number {
  if (GENERIC_MENU_LABEL_RE.test(label)) return MENU_LABEL_TIERS.length + 1;
  const tier = MENU_LABEL_TIERS.findIndex((re) => re.test(label));
  return tier === -1 ? MENU_LABEL_TIERS.length : tier;
}

/**
 * Collapse menus that hold exactly the same dishes into one.
 *
 * Discovery can legitimately find the same menu at two addresses — a "/menu"
 * page and an "à la carte" PDF that are byte-for-byte the same content, or two
 * nav links pointing at one document. Extraction then produces two menus with
 * identical dish lists, and the app shows the diner a picker whose options are
 * indistinguishable. Measured in production: 14 of 88 analysed restaurants had
 * at least one such pair, and rasam.ie had FOUR menus that were really two
 * (À la carte == Early Bird, 42 dishes for 42).
 *
 * The test is EXACT set equality, deliberately — never "mostly a subset". A
 * real Early Bird IS a strict subset of the à la carte, and a subset rule would
 * delete genuine menus; an exact match cannot, because a real subset menu is
 * smaller. Exact equality alone accounted for 12 of those 14 restaurants.
 *
 * Prices are ignored: the same dish list at two price points (early bird vs à
 * la carte) is the SAME menu offered on different terms, and showing it twice
 * is the bug being fixed. Only dish identity distinguishes menus here.
 *
 * Exported for testing.
 */
export function collapseIdenticalMenus(sections: RawSection[]): RawSection[] {
  const dishesByLabel = new Map<string, Set<string>>();
  for (const section of sections) {
    const label = section.menuLabel;
    if (!label) continue; // untagged sections are a single menu already
    if (!dishesByLabel.has(label)) dishesByLabel.set(label, new Set());
    const set = dishesByLabel.get(label)!;
    for (const dish of section.dishes) set.add(normName(dish.name));
  }

  const labels = Array.from(dishesByLabel.keys());
  if (labels.length < 2) return sections;

  const sameDishes = (a: string, b: string): boolean => {
    const [x, y] = [dishesByLabel.get(a)!, dishesByLabel.get(b)!];
    if (x.size !== y.size || x.size < MIN_IDENTICAL_MENU_DISHES) return false;
    for (const name of Array.from(x)) if (!y.has(name)) return false;
    return true;
  };

  // Greedy: walk in discovery order, and for each surviving menu drop every
  // later menu holding the same dishes. When the loser has the better name,
  // the survivor takes it over, so the collapse never costs us the clearer
  // label (a "Menu" duplicated by "À La Carte" ends up called "À La Carte").
  const dropped = new Set<string>();
  const renamed = new Map<string, string>();
  for (let i = 0; i < labels.length; i++) {
    if (dropped.has(labels[i])) continue;
    for (let j = i + 1; j < labels.length; j++) {
      if (dropped.has(labels[j]) || !sameDishes(labels[i], labels[j])) continue;
      dropped.add(labels[j]);
      if (menuLabelTier(labels[j]) < menuLabelTier(labels[i])) renamed.set(labels[i], labels[j]);
    }
  }
  if (dropped.size === 0) return sections;

  // One menu left ⇒ present it as an ordinary single menu (menuLabel null),
  // exactly as a restaurant that only ever had one menu is stored.
  const survivors = labels.filter((label) => !dropped.has(label));
  const single = survivors.length === 1;

  return sections
    .filter((section) => !section.menuLabel || !dropped.has(section.menuLabel))
    .map((section) => {
      if (!section.menuLabel) return section;
      if (single) return { ...section, menuLabel: null };
      const rename = renamed.get(section.menuLabel);
      return rename ? { ...section, menuLabel: rename } : section;
    });
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
 *
 * Finally, menus that end up holding exactly the same dishes are folded into
 * one — see collapseIdenticalMenus. That is not cross-menu dish de-dup (which
 * would be wrong, per the paragraph above); it removes a whole menu only when
 * it is indistinguishable from another.
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

  // Last: fold away any menus that turned out to be the same menu twice. Runs
  // on the finished sections rather than on the candidate list so it catches
  // both causes — two candidates that returned the same document, and one page
  // the extraction split into two identically-stocked named menus.
  return { restaurantName, language, cuisine, sections: collapseIdenticalMenus(sections) };
}

/**
 * Real, substantial menus among several candidates about to be merged —
 * drops thin/junk results (e.g. a page's course-tier pricing blurb misread
 * as a handful of fake "dishes": "Menu 5 courses €86") ONLY when at least
 * one OTHER candidate already clears MIN_FOOD_ITEMS on its own; a restaurant
 * whose one true source is genuinely small must still be shown, not
 * reported as "no menu found".
 *
 * Without this, a junk second candidate (sections.length > 0, but far below
 * MIN_FOOD_ITEMS) was enough to make mergeMenus treat the merge as
 * multi-candidate and overwrite a GOOD candidate's own correct internal
 * menuLabel tagging with meaningless outer candidate labels — found on
 * restaurantdekas.com: the homepage's course-tier price text ("Menu 3
 * courses", "Menu 4 courses"...) qualified as a second "menu" purely by
 * having sections, and that alone corrupted the real PDF candidate's
 * correct Lunch/Dinner split into a flat, wrongly-labeled "Dishes" section.
 */
export function selectSubstantialMenus(
  named: Array<{ label: string; menu: ClassifiedMenu }>
): Array<{ label: string; menu: ClassifiedMenu }> {
  const strong = named.filter(
    (n) => countFoodItems(n.menu) >= MIN_FOOD_ITEMS && !looksLikeHeaderItems(n.menu)
  );
  return strong.length > 0 ? strong : named;
}

/** Extract every selected candidate (bounded) and merge into a single menu. */
export async function extractAndMerge(
  candidates: MenuCandidate[],
  ctx: ExtractContext
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  // Candidates with their own dedicated `pdf` candidate must never also be
  // re-read via another candidate's fallback (see ExtractContext.excludePdfUrls).
  const independentPdfRefs = candidates.filter((c) => c.type === 'pdf').map((c) => c.ref);
  const scopedCtx: ExtractContext = {
    ...ctx,
    excludePdfUrls: Array.from(new Set([...(ctx.excludePdfUrls ?? []), ...independentPdfRefs])),
    // Run-scoped, shared by reference across every candidate below so the
    // Promise.all fan-out pays once for identical fallback sources and cannot
    // buy one Sonnet escalation per candidate.
    sharedAttempts: ctx.sharedAttempts ?? new Map(),
    escalationBudget: ctx.escalationBudget ?? { remaining: DEFAULT_ESCALATION_BUDGET },
    anyCandidateValid: ctx.anyCandidateValid ?? { value: false },
  };
  const results = await Promise.all(
    candidates.map(async (c) => {
      const r = await extractMenuResumable(c, scopedCtx);
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

  const merged = mergeMenus(selectSubstantialMenus(named));

  // Strong-model audit of the veg/vegan labels. OFF by default since
  // 2026-08-08 (see VERIFY_VEG_ENABLED in lib/ai.ts) — a no-op returning
  // `merged` unless VERIFY_VEG=1, so don't announce it when it isn't running.
  if (VERIFY_VEG_ENABLED) {
    ctx.onProgress?.('Double-checking the vegetarian and vegan labels...');
  }
  const verified = await verifyVegClassifications(merged, ctx.title);
  usage = sumUsage(usage, verified.usage);

  return {
    menu: verified.menu,
    usage: usage ?? { model: EXTRACTION_USAGE_FALLBACK, tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };
}

const EXTRACTION_USAGE_FALLBACK = 'unknown';
