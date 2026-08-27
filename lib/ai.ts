import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedMenu, DietaryClassification } from '@/types';
import { isModifierSectionName, modifierDishes } from '@/lib/menu-modifiers';
import { DIETARY_FILTERS } from './dietary-config';
import { recordSpend } from './ai-spend';
import { documentUrlCandidates } from './doc-url';
import { readPage, DOCUMENT_TIMEOUT_MS } from './reader';
import { clampTimeout, outOfTime } from './deadline';

// Pricing per million tokens (as of claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-8)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-8':           { input: 5.00, output: 25.00 }, // kept for historical cost rows
};

// Model tiers (cost-first with a quality guardrail):
// - Haiku does discovery AND extraction — reading dish names off a menu is
//   mechanical OCR-style work it handles well, at ~1/3 of Sonnet's price.
// - Sonnet is the escalation when Haiku's extraction fails validation, and it
//   also double-checks every vegan/vegetarian label before results are saved
//   (verifyVegClassifications below) — misclassifying a meat dish as
//   vegetarian is a trust-breaking bug, so the strong model keeps the final
//   say on those labels while touching only a fraction of the tokens.
// - Opus is no longer in the pipeline: for menu OCR it rarely beat Sonnet and
//   cost 1.7x more per token.
export const DISCOVERY_MODEL = 'claude-haiku-4-5-20251001';
export const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
export const ESCALATION_MODEL = 'claude-sonnet-4-6';
export const VERIFICATION_MODEL = 'claude-sonnet-4-6';

/**
 * The Sonnet second-opinion pass on veg labels is OFF by default (2026-08-08).
 * Founder's call: Haiku's vegan/vegetarian/non-veg classification is already
 * accurate in practice, and every dish is human-reviewed before publishing, so
 * a paid model re-check earns nothing. The measured spend it removes is small
 * ($0.28/fortnight) but it also frees a Sonnet round-trip of deadline headroom
 * in the serverless analyze path, where it competed with extraction for time.
 * Set VERIFY_VEG=1 to restore it (e.g. to re-measure label accuracy) with no
 * code change — the function itself is kept for exactly that.
 */
export const VERIFY_VEG_ENABLED = process.env.VERIFY_VEG === '1';

export type AIUsage = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Prompt-cache tokens, split out of `tokensIn` so hit rate is answerable
   *  from the ledger. `tokensIn` still holds the full prompt (uncached +
   *  write + read), so nothing downstream changes if these are ignored.
   *  Optional because test fixtures fabricate usage objects by hand. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
};

// Browser-shaped UA for fetching linked assets (PDFs, images). Some hosts
// reject anything that doesn't look like a browser.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * A call that reached Anthropic — and was therefore BILLED — but whose result
 * we could not use (truncated JSON, unexpected content type, parse failure).
 *
 * It exists because the alternative loses money silently. A helper typed
 * `Promise<T | null>` that returns `null` on failure returns a shape that
 * cannot carry usage, so spend Anthropic had already charged us for vanished
 * from every in-process total. That is the 2026-07-25 8× undercount pattern in
 * `CLAUDE.md`, and live run #33 showed it still biting: three restaurants
 * reported "$0.0000 spent" while having made real calls (New King made four).
 *
 * `callClaude` still records every call to `ai_usage_log` the moment it
 * returns — that ledger was always right. This is what keeps the *in-process*
 * figure (what the retry ladder sums, what the pipeline suite prints, what the
 * route attributes to a restaurant) honest as well.
 */
export class AICallError extends Error {
  usage?: AIUsage;
  /** True when the model hit max_tokens — the output is cut off, not wrong. */
  truncated: boolean;
  /**
   * True when the model READ the source fine and reported no menu in it —
   * as opposed to malfunctioning (invalid JSON, truncation) or never being
   * reached at all. The distinction decides whether escalating to the
   * stronger model can possibly help: re-reading the same empty page with a
   * pricier model returns the same verdict, and 75% of escalation spend went
   * exactly there. See `shouldEscalate` in lib/menu-extract.ts.
   */
  empty: boolean;
  constructor(message: string, usage?: AIUsage, truncated = false, empty = false) {
    super(message);
    this.name = 'AICallError';
    this.usage = usage;
    this.truncated = truncated;
    this.empty = empty;
  }
}

/** Usage for a message that already came back from the API. */
export function usageOf(message: Anthropic.Message): AIUsage {
  const u = message.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const model = String(message.model);
  return {
    model,
    tokensIn: u.input_tokens + cacheWrite + cacheRead,
    tokensOut: u.output_tokens,
    costUsd:
      calcCost(model, u.input_tokens, u.output_tokens) +
      calcCost(model, Math.round(cacheWrite * 1.25 + cacheRead * 0.1), 0),
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  };
}

/** True for Anthropic account failures (credits exhausted, monthly usage cap
 *  reached, invalid/missing API key) — callers must surface these instead of
 *  swallowing them into "couldn't read the menu" fallbacks. A swallowed account
 *  failure is a trust bug: it makes EVERY restaurant look like it has no menu
 *  (uniform failures, $0 logged) when the real cause is that the AI is switched
 *  off. The monthly-cap message ("You have reached your specified API usage
 *  limits. You will regain access on …") shares none of the credit/key wording,
 *  so it must be matched explicitly. */
export function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /credit balance|billing|purchase credits|usage limit|authentication_error|invalid x-api-key|api key/i.test(msg);
}

function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // An unpriced model ID used to fall back to Sonnet rates in silence, which
    // is how a mispriced row would slip through unnoticed. Still fall back, but
    // say so.
    console.warn(`[ai] no pricing for model "${model}" — costing at Sonnet rates; add it to MODEL_PRICING`);
  }
  const p = pricing ?? { input: 3.00, output: 15.00 };
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

// The Anthropic SDK's own default is 10 minutes per call — far past Vercel's
// 60s hard cap. lib/deadline.ts clamps every reader/fetch/upload timeout to
// the request's remaining budget, but until now nothing clamped the model
// call itself: one slow generation could silently run the function straight
// into the platform's kill with no graceful continue/checkpoint, exactly
// reproducing the "connection dropped" bug this file's callers exist to fix.
// Outside a withDeadline context (scripts, admin reparse) clampTimeout
// returns this value unchanged, so a single call still can't hang forever.
const DEFAULT_CALL_TIMEOUT_MS = 55_000;

/**
 * The single path every Anthropic call goes through.
 *
 * Records spend *immediately* after the response arrives and before any parsing,
 * validation, or early return — see lib/ai-spend.ts for why (July's logged spend
 * was ~8× under the Console because failure paths dropped their usage on the
 * floor). Adding a new AI call means calling this, so a new call can't silently
 * go unbilled.
 *
 * A timeout here throws before any response arrives, so (like any other failed
 * call) it carries no usage to record — the same shape as a network error. If
 * Anthropic billed for work already done server-side before the abort, that
 * spend is invisible to us either way; clamping doesn't create a new blind
 * spot, it only stops the *whole request* from dying with zero chance to
 * checkpoint what earlier candidates already found.
 *
 * Returns the raw message; callers parse it as before.
 */
export async function callClaude(
  params: Anthropic.MessageCreateParamsNonStreaming,
  // Per-request options (extra headers, e.g. a beta gate). Deliberately routed
  // THROUGH this function rather than around it: a call that needs a header is
  // still a call that must be recorded, and the previous shape tempted callers
  // to reach for the raw client to get one.
  options?: { headers?: Record<string, string> }
): Promise<Anthropic.Message> {
  const message = await anthropic().messages.create(params, {
    ...options,
    timeout: clampTimeout(DEFAULT_CALL_TIMEOUT_MS),
  });

  // Cache tokens are priced differently from fresh input: writes at 1.25× and
  // reads at 0.1×. The extraction calls now mark a cache breakpoint (see
  // SYSTEM_PROMPT), so these are real numbers on the Sonnet path and zero on
  // the Haiku path, whose 4096-token minimum our prefix doesn't reach.
  //
  // The installed SDK (0.27.x) doesn't declare these two fields even though the
  // API returns them, so widen the type rather than drop the handling.
  const u = message.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  // usage.input_tokens is the *uncached remainder*, not the whole prompt.
  const tokensIn = u.input_tokens + cacheWrite + cacheRead;
  const tokensOut = u.output_tokens;

  const model = String(params.model);
  const costUsd =
    calcCost(model, u.input_tokens, tokensOut) +
    calcCost(model, Math.round(cacheWrite * 1.25 + cacheRead * 0.1), 0);

  await recordSpend({
    model,
    tokensIn,
    tokensOut,
    costUsd,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  });
  return message;
}

// Lazy client: constructing the SDK at module load throws when no API key is
// set (unit tests, CI builds). Same pattern as lib/db.ts.
let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || undefined });
  return _anthropic;
}

export const SYSTEM_PROMPT = `You are a dietary classifier specializing in vegetarian and vegan restaurant menus.

Your task: analyse a restaurant menu and classify each FOOD dish accurately.

A menu is always WRITTEN TEXT — dish names, descriptions, and prices — even when it is presented inside an image, a PDF, or a photographed menu board. Work only from that written text. Photographs of food, plates, or the restaurant are decoration, not menu content.

CRITICAL — WHAT TO INCLUDE vs. EXCLUDE:
- INCLUDE: all individual food dishes — starters, mains, sides, desserts, sharing plates, etc.
- EXCLUDE selectable components and variation price lists. A shared ladder such as "Chicken €23.50 / Beef €24 / Tofu €20.95 / Vegetable €20.95" describes choices for the surrounding curries, stir-fries or noodles; Chicken, Beef, Tofu and Vegetable are NOT separate dishes. Never create a "Protein Options", "Protein Customization" or similar output section.
- KEEP each real dish that uses the shared choices exactly once. State the vegetarian choice in that dish's description/reason, and put the visible price range or choice-dependent prices on the real dish rather than emitting the choices as dishes.
- EXCLUDE completely (do not add to any section): ALL beverages — wines, beers, spirits, cocktails, soft drinks, juices, coffee, tea, water, smoothies, or any drink item. Most users assume drinks are vegetarian; listing them wastes space.
- EXCLUDE: menu section headers used as dish names (e.g. "Daily Dim Sum Menu", "Today's Specials", "Set Menu €35 per person", "Starter Selection"). These are categories, not individual dishes.
- EXCLUDE: non-dish text like opening hours, allergen notices, chef's notes, reservation policies.
- If a section contains ONLY drinks, omit that entire section from the output.
- NEVER invent, guess, or infer dishes that are not explicitly written in the provided menu content. Only include dishes whose names appear as text in the source.

CRITICAL — MULTI-LANGUAGE / BILINGUAL MENUS:
- Some menus list each dish in two languages (e.g. French and English, or Spanish and English), either side by side or stacked. Output each dish EXACTLY ONCE — never as two separate entries. Use the dish's primary/original language for the "name" and put any translation in the description.
- Do not let a translated duplicate inflate the dish count.
- If a dish is written ONLY in a non-English language (the menu offers no English version of it), KEEP the original-language dish name in "name" and ADD a concise English translation of the dish — and its key ingredients — to the "description", so an English-speaking reader understands it. Do NOT translate the "name" itself, and do not drop the original description; append the English translation to it. This applies to any language (Dutch, French, German, etc.).

CRITICAL — MULTIPLE DISTINCT NAMED MENUS ON ONE PAGE OR IN ONE DOCUMENT:
- Some pages, or some multi-page PDFs/documents, present several completely separate, independently-named menus, each with its own set of sections/courses. They are named for a COURSE STYLE ("À La Carte", "Tasting Menu", "Set Lunch", "Group Menu") or, just as often, for a TIME OR OCCASION they are served at: "Early Bird", "Late Bird", "Happy Hour", "Brunch", "Lunch", "Dinner", "Pre-Theatre", "Sunday". A time-based name is a menu name like any other — treat it exactly the same way. This applies whether the separate menus appear as headings back to back on one page, OR as separate physical pages within one PDF (e.g. page 1 headed "LUNCH", page 2 headed "DINNER") — a page break does not exempt you from this rule. This is different from one menu with several sections (Starters/Mains/Desserts).
- TWO STRONG TELLS that you are looking at more than one menu, either of which is enough:
  (a) A SECTION NAME REPEATS. If you find "starters" twice, or "mains" twice, in the same document, it is almost never one menu with two starter sections — it is two menus printed one after the other. Find the heading above each repeat and use it as that group's menuLabel.
  (b) THE PRICING STYLE CHANGES. One group priced as a whole ("2 courses €32.50", "3 courses €37.75") followed by a group priced per dish ("€8.95", "€23.50") is two menus, not one. Dishes on a set-price menu often have NO individual price — that is expected, still list them, and leave their price empty.
- The same dish frequently appears on several of these menus, because a set-price or early-bird menu is usually a REDUCED SELECTION of the main one. Heavy overlap is normal and is NOT a reason to merge them or to drop either — list each menu in full, separately.
- When this happens, set "menuLabel" on EVERY section to that section's specific named menu (e.g. "À La Carte", "Tasting Menu", "Lunch", "Dinner"), using the menu's own name from the page, shortened naturally.
- Keep the section's own "name" clean — do NOT prefix or repeat the menu name inside it (e.g. "Starters", never "À La Carte - Starters"). "menuLabel" is where the menu name belongs.
- If the page really does describe just ONE menu, omit "menuLabel" or set it to null for every section. Do not force a split that isn't there — but do not merge two clearly-headed menus into one either. Returning one flat menu where the restaurant prints two is a visible error to any reader who opens the page.
- A dish that genuinely appears on MORE THAN ONE of these named menus (e.g. a dessert offered at both lunch and dinner, printed on both pages) must be listed separately under EACH menu it appears on — do not drop it as a duplicate. This is different from the bilingual-duplicate rule above, which is about the SAME dish printed twice in two languages within one listing; a dish intentionally repeated across two distinct named menus is not a duplicate to remove.

Classification rules:
- "vegan": dish contains only plant-based ingredients with no animal products whatsoever
- "vegetarian": dish contains no meat, poultry, or fish, but may contain dairy, eggs, or honey
- "neither": dish contains meat, poultry, fish, or seafood
- "unknown": classification is genuinely unclear (e.g. "soup of the day" with no ingredient info)

CRITICAL — DISHES WHERE THE DINER CHOOSES THE PROTEIN OR TOPPING:
- Many dishes are listed once but let the customer pick: "Pad Thai — choice of tofu, chicken, prawn or beef", "Brown roll with a choice of cheese, ham or salami", "Cheese toastie. Optional: ham (+1)".
- If ANY of the selectable options is vegetarian (or the meat is described as optional/an extra), classify the dish as "vegetarian" — or "vegan" if a fully plant-based choice is available and the base contains no dairy or egg. A vegetarian CAN eat this dish, so it must not be hidden from them as "neither".
- Only use "neither" when every available choice contains meat, poultry or fish (e.g. "Stir-fried beef or chicken noodles").
- When you classify this way you MUST say so in the "description": name the vegetarian option explicitly, e.g. "choose tofu" or "ask for it without ham". The diner has to know the dish needs a choice — never leave it looking unconditionally vegetarian.
- Put the same note in "reason" (e.g. "veg if ordered with tofu").

CRITICAL — watch for hidden non-vegetarian ingredients:
- Fish sauce, oyster sauce, worcestershire sauce (often in Asian, Italian dishes)
- Beef/chicken/fish stock in soups, risottos, stews
- Anchovies in Caesar dressing, puttanesca sauce, some salads
- Gelatin in desserts, jellies, panna cotta
- Lard or suet in pastry
- Parmesan cheese is technically not vegetarian (uses animal rennet) — note this but classify as vegetarian unless explicitly stated
- Meat broths in "vegetable" soups
- Prawn crackers, prawn toast

Confidence score (0.0 to 1.0):
- 0.9–1.0: explicit marker like "(v)", "(ve)", "vegan" on the menu, or unmistakably obvious
- 0.7–0.9: clear from ingredients listed, no ambiguity
- 0.5–0.7: likely based on dish name/type but some ingredients unstated
- 0.3–0.5: uncertain, could go either way
- 0.1–0.3: very uncertain, needs confirmation

Always include a brief "reason" (under 12 words) explaining your classification decision.

Return ONLY valid JSON in this exact structure:
{
  "restaurantName": "string or null",
  "language": "detected language, e.g. 'English', 'French'",
  "cuisine": "one- or two-word cuisine type, e.g. 'Italian', 'Indian', 'Chinese', 'Modern European', or null if unclear",
  "sections": [
    {
      "name": "section name e.g. Starters, Mains, Desserts",
      "menuLabel": "name of the specific named menu this section belongs to, e.g. 'À La Carte', 'Tasting Menu' — ONLY when the page presents multiple distinct named menus (see rule above); null for the ordinary single-menu case",
      "dishes": [
        {
          "name": "dish name",
          "description": "brief description if available, else null",
          "price": "price as string if visible, else null",
          "classification": "vegan|vegetarian|neither|unknown",
          "confidence": 0.85,
          "reason": "brief explanation"
        }
      ]
    }
  ]
}`;

/**
 * SYSTEM_PROMPT as a cached prefix, shared by all three extraction call sites.
 *
 * The prompt is a frozen constant — byte-identical on every call, with nothing
 * dynamic interpolated — which makes it the ideal thing to cache: it is re-sent
 * on each of the ~11 AI calls a restaurant costs. Cache reads bill at 0.1× and
 * writes at 1.25×, so within a single analysis this is a clear win.
 *
 * BUT: Anthropic enforces a *minimum cacheable prefix* that differs per model —
 * 4096 tokens on Haiku 4.5, 1024 on Sonnet 4.6. This prompt is ~1.8k tokens, so
 * on the Haiku path (DISCOVERY_MODEL/EXTRACTION_MODEL, i.e. nearly all our
 * spend) the marker below is a SILENT NO-OP: no error, just
 * cache_creation_input_tokens: 0 forever. It starts paying only when a chunk
 * escalates to Sonnet.
 *
 * That is deliberate, not dead code. Leaving the breakpoint in place means the
 * escalation path — our most expensive one — caches today, and that Haiku
 * caching switches on automatically if the shared prefix ever grows past 4096
 * tokens. Growing it is the real prize (worth roughly 15-20% of pipeline
 * spend), but it means editing the classification prompt, which needs a quality
 * re-verification run. Use `npx tsx scripts/count-prompt-tokens.ts` (free) to
 * check where the prompt currently sits against each model's minimum.
 *
 * Default 5-minute TTL, not 1h: the 1h TTL doubles the write cost (2× vs
 * 1.25×) and only pays across long idle gaps, whereas our calls cluster inside
 * one analysis.
 *
 * The type widening mirrors the `usage` widening in callClaude — SDK 0.27.x
 * doesn't declare cache_control on TextBlockParam even though the API is GA.
 */
const CACHED_SYSTEM = [
  {
    type: 'text' as const,
    text: SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' as const },
  },
] as unknown as Anthropic.TextBlockParam[];

function buildPrompt(menuText: string, restaurantName?: string): string {
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';
  return `${nameHint}Analyse this restaurant menu and classify all dishes. Return ONLY JSON.\n\nMenu content:\n\n${menuText.slice(0, 30000)}`;
}

/** Text longer than this is split before extraction rather than after a
 *  wasted truncated call. Sized from the failure that motivated it: New King's
 *  13,552-character menu reliably overran the 8,192-token output cap. */
const CHUNK_CHARS = 9000;
/** Hard cap on splits, so a pathological page can't fan out into many calls. */
const MAX_CHUNKS = 4;

/** Split on blank lines / list boundaries so a dish is never cut in half. */
function splitMenuText(text: string, parts: number): string[] {
  if (parts <= 1) return [text];
  const target = Math.ceil(text.length / parts);
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length >= target && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function mergeSections(menus: ClassifiedMenu[]): ClassifiedMenu {
  const base = menus[0] ?? { sections: [] };
  return {
    restaurantName: menus.find((m) => m.restaurantName)?.restaurantName,
    language: menus.find((m) => m.language)?.language,
    cuisine: menus.find((m) => m.cuisine)?.cuisine ?? base.cuisine,
    sections: menus.flatMap((m) => m.sections),
  };
}

/** One extraction call over one piece of text. Throws AICallError (carrying
 *  usage) rather than a bare Error, so a billed-but-unusable call is never
 *  dropped from the spend total. */
async function classifyMenuChunk(
  menuText: string,
  model: string,
  restaurantName?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  const message = await callClaude({
    model,
    max_tokens: 8192, // large menus (50+ dishes) overflow 4096 and truncate the JSON
    system: CACHED_SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(menuText, restaurantName) }],
  });
  const usage = usageOf(message);

  // Truncated output is not a bad model, it's too many dishes for one response.
  // Flag it so the caller can split and retry instead of discarding the work.
  if (message.stop_reason === 'max_tokens') {
    throw new AICallError('AI response hit the output limit before finishing the menu.', usage, true);
  }

  const content = message.content[0];
  if (content.type !== 'text') throw new AICallError('Unexpected AI response type', usage);

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;

  try {
    return { menu: stripDrinksAndHeaders(JSON.parse(jsonText) as ClassifiedMenu), usage };
  } catch {
    throw new AICallError('AI returned invalid JSON. Please try again.', usage);
  }
}

export async function classifyMenuWithAI(
  menuText: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  // Cost-first: extraction defaults to Haiku; an explicit override (e.g.
  // Sonnet escalation when validation fails) wins. Veg labels get a Sonnet
  // double-check downstream regardless of which model extracted.
  const model = modelOverride ?? EXTRACTION_MODEL;

  // Pre-split obviously-oversized menus. Cheaper than paying for a truncated
  // call first and splitting afterwards, and the input cost is the same either
  // way (the text is sent once in total, just across several messages).
  const plannedChunks = Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(menuText.length / CHUNK_CHARS)));

  const runChunks = async (parts: number): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> => {
    const pieces = splitMenuText(menuText, parts);
    const menus: ClassifiedMenu[] = [];
    let usage: AIUsage | undefined;
    let truncatedUsage: AIUsage | undefined;
    for (const piece of pieces) {
      try {
        const res = await classifyMenuChunk(piece, model, restaurantName);
        menus.push(res.menu);
        usage = addUsage(usage, res.usage);
      } catch (err) {
        // Keep every billed call in the total, whatever the outcome.
        if (err instanceof AICallError) {
          usage = addUsage(usage, err.usage);
          if (err.truncated) truncatedUsage = usage;
          else throw new AICallError(err.message, usage, false);
        } else {
          throw err;
        }
      }
    }
    if (truncatedUsage && parts < MAX_CHUNKS) {
      // Still too big even split this way — split finer and try again. The
      // already-spent usage rides along so it can't disappear.
      const finer = await runChunks(Math.min(MAX_CHUNKS, parts * 2));
      return { menu: finer.menu, usage: addUsage(usage, finer.usage)! };
    }
    if (menus.length === 0) {
      throw new AICallError('AI response hit the output limit before finishing the menu.', usage, true);
    }
    return { menu: mergeSections(menus), usage: usage! };
  };

  return runChunks(plannedChunks);
}

/** Sum two usages; either may be undefined. Kept local to avoid importing from
 *  menu-extract (which imports this module). */
function addUsage(a: AIUsage | undefined, b: AIUsage | undefined): AIUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    model: a.model === b.model ? a.model : `${a.model}+${b.model}`,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    costUsd: a.costUsd + b.costUsd,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  };
}

async function downloadImageAsBase64(
  url: string
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) return null; // skip > 5MB

    // Anthropic only accepts jpeg/png/gif/webp. Server Content-Type is often
    // wrong (octet-stream, image/jpg) — sniff magic bytes to be safe.
    const headerType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const bytes = new Uint8Array(buffer);
    const mediaType = sniffImageType(bytes) ?? normalizeImageType(headerType);
    if (!mediaType) return null; // not a supported image

    const data = Buffer.from(buffer).toString('base64');
    return { data, mediaType };
  } catch {
    return null;
  }
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function normalizeImageType(type: string): string | null {
  if (type === 'image/jpg') return 'image/jpeg';
  return SUPPORTED_IMAGE_TYPES.has(type) ? type : null;
}

/** Detect image type from magic bytes (more reliable than Content-Type). Exported
 *  for the admin upload path, which must not trust a client-declared MIME type. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  return null;
}

/**
 * OCR-style instruction for vision extraction. Menus are text; images are just
 * a container. Exported so tests can guard against prompt regressions.
 */
export const IMAGE_OCR_INSTRUCTION =
  'Read ONLY the text visibly written in the image(s): printed or handwritten menu text with dish names, descriptions, and prices. ' +
  'Treat this as OCR — transcribe and classify what is written, nothing more. ' +
  'NEVER infer or invent dishes from photographs of food, plates, drinks, ingredients, people, or the restaurant interior; a photo of dumplings is NOT a menu entry. ' +
  'If some images are food photography and others contain a written menu, use only the written menu. ' +
  'If no readable menu text is present in any image, return {"sections": []}.';

export async function classifyMenuFromImages(
  imageUrls: string[],
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  const downloaded = await Promise.all(imageUrls.map(downloadImageAsBase64));
  const images = downloaded.filter(Boolean) as Array<{ data: string; mediaType: string }>;
  if (images.length === 0) return null;
  return classifyMenuFromImageBuffers(images, restaurantName, modelOverride);
}

/**
 * Same as classifyMenuFromImages but for image data already in hand (e.g. an
 * admin's manually uploaded photo of a menu — a Google Maps screenshot, say —
 * that has no URL to fetch). Split out so both entry points share one
 * implementation instead of the upload path duplicating the API call.
 */
export async function classifyMenuFromImageBuffers(
  images: Array<{ data: string; mediaType: string }>,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  if (images.length === 0) return null;

  const model = modelOverride ?? EXTRACTION_MODEL;
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';

  const message = await callClaude({
    model,
    max_tokens: 8192, // large menus (50+ dishes) overflow 4096 and truncate the JSON
    system: CACHED_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.data,
            },
          })),
          {
            type: 'text' as const,
            text: `${nameHint}${IMAGE_OCR_INSTRUCTION}\n\nClassify every dish found in the written menu text. Return ONLY JSON.`,
          },
        ],
      },
    ],
  });

  // The call is billed the moment it returns, so every exit below carries its
  // usage rather than returning a bare null (see AICallError).
  const usage = usageOf(message);
  const content = message.content[0];
  if (content.type !== 'text') throw new AICallError('Unexpected AI response type', usage);
  if (message.stop_reason === 'max_tokens') {
    throw new AICallError('AI response hit the output limit before finishing the menu.', usage, true);
  }

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;

  let menu: ClassifiedMenu;
  try {
    menu = JSON.parse(jsonText) as ClassifiedMenu;
  } catch {
    throw new AICallError('AI returned invalid JSON from images.', usage);
  }

  // No dishes is a legitimate answer (the images weren't a menu), not a
  // failure — but it still cost money, so report it as a priced empty result.
  if (!menu.sections || menu.sections.length === 0) {
    // empty=true: the model saw the images and found no menu — not a malfunction.
    throw new AICallError('No menu text found in the images.', usage, false, true);
  }

  return { menu: stripDrinksAndHeaders(menu), usage };
}

/**
 * Vision extraction from a hosted full-page screenshot (e.g. Firecrawl's
 * `screenshot` URL). Reuses the image-classification path — a last-resort
 * fallback for canvas/image-only pages where text and discrete images failed.
 */
export async function classifyMenuFromScreenshot(
  screenshotUrl: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  return classifyMenuFromImages([screenshotUrl], restaurantName, modelOverride);
}

export interface LabeledCandidate {
  ref: string;
  label: string;
  /** One-line, diner-facing description (e.g. "Mains, sharing plates & desserts") for the menu picker. */
  description?: string;
  isDistinctMenu: boolean;
  isDrinkOnly: boolean;
  duplicateOf: number | null;
}

/** Exported for prompt-regression tests. */
export function buildLabelPrompt(
  candidates: Array<{ ref: string; hint: string; type: string; url?: string }>,
  restaurantName?: string
): string {
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n` : '';
  const list = candidates
    .map((c, i) => `${i}. [${c.type}] hint: "${c.hint || '(none)'}"${c.url ? ` url: ${c.url}` : ''}`)
    .join('\n');

  return `${nameHint}Below is a list of candidate menu sources found on a restaurant website (each is a link, PDF, image, or the page text itself). For EACH item decide:

1. "label": a short, human-distinguishable name a diner would recognise, e.g. "Lunch", "Dinner", "À la carte", "Weekend Brunch", "Set Menu", "Mon–Thu", "Fri–Sun". Use the hint and URL slug. NEVER use meta-labels like "Menu images", "Menus", "Main website", "Page text" — describe WHICH menu it is. If you genuinely can't tell, use "Menu".
2. "description": a short one-line description (under 8 words) of what's likely on this menu, e.g. "Mains, sharing plates & desserts" or "Roasts, sides & the veg board" — inferred from the label/hint/URL. Helps a diner pick between similar-sounding menus. Keep it plain and concrete, not marketing copy.
3. "isDistinctMenu": true only if it is a real DINING menu a diner would choose between when eating in. False for navigation/about/contact/gallery/booking/gift-voucher links, social media, login/account/checkout pages, or anything that is not actually a menu. ALSO false for: allergen sheets/menus, catering menus, kids'/children's menus, group-booking or set-party packages, and collection/delivery/takeaway ordering menus — these are not the dine-in menus we show. Note: online-ordering pages (Toast, Square, etc.) usually contain the restaurant's live food menu — those ARE menus.
4. "isDrinkOnly": true if the source is exclusively drinks (wine list, cocktail list, beverages, bar list). This app analyses FOOD only — drink lists are discarded. A menu that includes both food and drinks is NOT drink-only.
5. "duplicateOf": if this candidate is the SAME menu as an earlier candidate in a different format (e.g. the same dinner menu as both a PDF and a web page, or the same URL twice), give that earlier candidate's index; otherwise null.

Candidates:
${list}

Return ONLY a JSON array, one object per candidate index, in order:
[{"index": 0, "label": "Dinner", "description": "Mains, sharing plates & desserts", "isDistinctMenu": true, "isDrinkOnly": false, "duplicateOf": null}, ...]`;
}

/**
 * Cheap Haiku pass that turns raw menu-source candidates into human-friendly,
 * de-duplicated menu labels and flags which are genuinely distinct FOOD menus.
 * Used by the discovery phase to drive the multi-menu picker.
 */
/**
 * Returns `{ candidates, usage }` rather than a bare array, because this call is
 * BILLED and every parse failure below returns the fallback labels.
 *
 * `Promise<LabeledCandidate[]>` is a shape that *cannot carry usage* — the exact
 * structural fault CLAUDE.md records as the cause of the 8× July-2026
 * undercount. `ai_usage_log` was never wrong (callClaude records at the API
 * boundary), but no caller could see this call's cost, so every *derived* total
 * — the `restaurants` cost columns, the reparse route's `costUsd`, the QA
 * suite's printed total — silently omitted one discovery call per analysis.
 * Measured on QA run #49: the ledger said $0.3692, the suite printed $0.3601.
 */
export async function labelMenuCandidates(
  candidates: Array<{ ref: string; hint: string; type: string; url?: string }>,
  restaurantName?: string
): Promise<{ candidates: LabeledCandidate[]; usage?: AIUsage }> {
  if (candidates.length === 0) return { candidates: [] };

  const plain = (): LabeledCandidate[] =>
    candidates.map((c) => ({ ref: c.ref, label: c.hint || 'Menu', isDistinctMenu: true, isDrinkOnly: false, duplicateOf: null }));

  const message = await callClaude({
    model: DISCOVERY_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildLabelPrompt(candidates, restaurantName) }],
  });
  // Captured before any parsing, so no return path below can drop it.
  const usage = usageOf(message);
  const fallback = () => ({ candidates: plain(), usage });

  const content = message.content[0];
  if (content.type !== 'text') return fallback();

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;
  try {
    const parsed = JSON.parse(jsonText) as Array<{
      index: number;
      label: string;
      description?: string;
      isDistinctMenu: boolean;
      isDrinkOnly?: boolean;
      duplicateOf?: number | null;
    }>;
    const labeled = candidates.map((c, i) => {
      const match = parsed.find((p) => p.index === i);
      return {
        ref: c.ref,
        label: match?.label?.trim() || c.hint || 'Menu',
        description: match?.description?.trim() || undefined,
        isDistinctMenu: match?.isDistinctMenu ?? true,
        isDrinkOnly: match?.isDrinkOnly ?? false,
        duplicateOf: typeof match?.duplicateOf === 'number' && match.duplicateOf >= 0 && match.duplicateOf < i ? match.duplicateOf : null,
      };
    });
    return { candidates: labeled, usage };
  } catch {
    return fallback();
  }
}

// Removed 2026-08-08: `analysePageForMenu` — an exported, billable Haiku call
// with zero callers anywhere in the repo. Discovery answers "is this a menu
// page?" via labelMenuCandidates. Deleted rather than left exported so nobody
// wires a second paid call back into the pipeline by reaching for it.

const DRINK_SECTION_NAMES = new Set([
  'drinks', 'beverages', 'wines', 'wine list', 'beer', 'beers', 'cocktails',
  'spirits', 'soft drinks', 'hot drinks', 'coffee', 'tea', 'juices',
  'boissons', 'vins', 'bières', 'bebidas', 'vinos', 'getränke', 'weine',
  'bar menu', 'drinks menu', 'drink menu',
]);

function isDrinkSectionName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return DRINK_SECTION_NAMES.has(lower);
}

/** Strip out drink-only sections and any residual drink entries the AI may have included. */
export function stripDrinksAndHeaders(menu: ClassifiedMenu): ClassifiedMenu {
  const cleaned = menu.sections
    .filter((s) => !isDrinkSectionName(s.name) && !isModifierSectionName(s.name))
    .map((s) => {
      const modifiers = modifierDishes(s);
      return {
        ...s,
        dishes: s.dishes.filter((d) => {
          if (modifiers.has(d)) return false;
          const nameLower = d.name.toLowerCase();
          // Reject obvious drink names the AI sometimes leaks through
          const drinkKeywords = [
            'wine', 'beer', 'lager', 'ale', 'stout', 'porter', 'cider',
            'cocktail', 'spirit', 'whiskey', 'whisky', 'gin', 'vodka', 'rum',
            'prosecco', 'champagne', 'sparkling', 'still water', 'mineral water',
            'soft drink', 'cola', 'lemonade', 'juice', 'smoothie',
            'coffee', 'espresso', 'cappuccino', 'latte', 'americano',
            'tea', 'herbal tea', 'hot chocolate',
          ];
          if (drinkKeywords.some((k) => nameLower.includes(k))) return false;
          // Reject category-header style entries (very short, no price, ends in "menu" or "selection")
          if (/\b(menu|selection|platter|board|option)s?\b$/i.test(d.name) && !d.description && !d.price) return false;
          return true;
        }),
      };
    })
    .filter((s) => s.dishes.length > 0);

  return { ...menu, sections: cleaned };
}

/** PDF magic bytes: every real PDF starts "%PDF-". */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Fetch a document the way a browser would.
 *
 * A bare User-Agent is not enough for a lot of hosts: tofuvegan.com serves a
 * real 8-page menu PDF that opens fine in Chrome, but our request came back as
 * something that wasn't a PDF at all. Sending the headers a browser actually
 * sends — Accept, Accept-Language, Referer from the file's own origin — is what
 * separates "the site blocks us" from "the file isn't there". The status and
 * content-type are logged so the next failure names itself instead of becoming
 * another silent "no menu".
 */
/**
 * Never throws.
 *
 * That is the whole point: when this threw on a network-level refusal (TLS
 * reset, connection refused — no HTTP response at all), the exception escaped
 * past classifyMenuFromPdf's reader fallback to the outer catch, and the
 * fallback never ran. tofuvegan.com failed exactly this way: a host that drops
 * our connection meant the one route that could still have read the menu was
 * skipped. Lina Stores only got rescued because its PDF returned a value
 * (too-large) instead of throwing.
 */
async function fetchDocument(url: string, depth = 0): Promise<ArrayBuffer | null> {
  try {
    return await fetchDocumentInner(url, depth);
  } catch (err) {
    // "Not allowed" is a different answer from "not there" and must survive.
    if (err instanceof MenuAccessBlockedError) throw err;
    // Log it: a silent network refusal is indistinguishable from "no menu".
    console.error(`[pdf] fetch threw for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchDocumentInner(url: string, depth = 0): Promise<ArrayBuffer | null> {
  let referer = '';
  try {
    referer = new URL(url).origin + '/';
  } catch {}
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { Referer: referer } : {}),
    },
    // Generous: the founder reports this PDF takes a few seconds in a browser,
    // and a slow menu PDF is still a menu.
    signal: AbortSignal.timeout(clampTimeout(45000)),
    redirect: 'follow',
  });
  if (!res.ok) {
    console.error(`[pdf] HTTP ${res.status} fetching ${url}`);
    const denied = accessDeniedReason(res.status, '');
    if (denied) throw new MenuAccessBlockedError(denied);
    return null;
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    console.error(`[pdf] too large (${buffer.byteLength} bytes): ${url}`);
    return null;
  }
  if (buffer.byteLength > INLINE_PDF_BYTES) {
    console.error(`[pdf] ${buffer.byteLength} bytes — too big to inline, will upload via the Files API: ${url}`);
  }
  if (!looksLikePdf(new Uint8Array(buffer.slice(0, 8)))) {
    const ct = res.headers.get('content-type') ?? 'unknown';
    console.error(`[pdf] not a PDF (content-type: ${ct}, ${buffer.byteLength} bytes): ${url}`);
    // Google Drive answers big files with a small HTML page carrying a confirm
    // FORM — the token is generated per request, so it cannot be guessed with a
    // static `confirm=t`. Read it out of the page and replay it once. Measured
    // on waterkantamsterdam.nl: 1,789 bytes of text/html from both endpoints.
    if (depth === 0 && ct.includes('text/html') && buffer.byteLength < 100_000) {
      const html = Buffer.from(buffer).toString('utf8');
      const followUp = driveConfirmUrl(html);
      if (followUp) {
        console.error(`[pdf] following Drive confirm form → ${followUp}`);
        return fetchDocument(followUp, depth + 1);
      }
      // No form to follow — say what the page actually SAYS. "Sign in",
      // "quota exceeded" and "not found" need completely different responses,
      // and 1,789 bytes of unexplained HTML told us nothing for two rounds.
      const visible = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      console.error(`[pdf] host returned a page instead of a file: "${visible.slice(0, 300)}"`);
      const denied = accessDeniedReason(res.status, visible);
      if (denied) throw new MenuAccessBlockedError(denied);
    }
    return null;
  }
  return buffer;
}

/**
 * Two limits, because there are two ways to send a document.
 *
 * Inline (base64 in the request body) inflates by a third, so the practical
 * ceiling is ~23 MB of PDF before the body passes the API's ~32 MB request
 * limit. 20 MB keeps a margin.
 *
 * Above that we upload the raw bytes via the Files API and reference the file
 * by id — no base64, so the inflation simply doesn't apply, and the only limit
 * left is the API's own 32 MB document size. tofuvegan.com's menu is a real
 * 26.4 MB PDF: under 32 MB as bytes, over it as base64. That gap is the entire
 * reason it read as "this restaurant has no menu".
 */
const INLINE_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;

/**
 * The menu exists and a person can open it, but we are not permitted to.
 *
 * Distinct from "this restaurant has no menu", and the difference matters to
 * the user: one is a fact about the restaurant, the other is a limitation of
 * ours, and only the second is worth asking them for help with.
 *
 * Real case: waterkantamsterdam.nl publishes its menu as a Google Drive file
 * the owner has set to view-only — Drive answers our download with "the owner
 * hasn't given you permission to download this file". Telling that user their
 * restaurant "doesn't publish a menu online" would simply be false.
 */
export class MenuAccessBlockedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = 'MenuAccessBlockedError';
  }
}

/** Host responses that mean "not allowed", as opposed to "not there". */
function accessDeniedReason(status: number, visibleText: string): string | null {
  if (/hasn't given you permission|only the owner and editors|request access|sign in to continue/i.test(visibleText)) {
    return 'the file owner has restricted downloads';
  }
  if (status === 401 || status === 403) return `the host refused our request (HTTP ${status})`;
  return null;
}

/**
 * Rebuild Google Drive's download URL from the confirm page it serves for
 * larger files. The page is a plain `<form>` whose hidden inputs carry a
 * per-request `uuid` alongside the file id — that's why a fixed `confirm=t`
 * doesn't work on its own.
 */
export function driveConfirmUrl(html: string): string | null {
  const action = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1];
  if (!action) return null;
  // Real hostname check, not a substring match: `action` is text lifted from a
  // fetched page, and the page itself can be from ANY restaurant site a user
  // submits — a substring test like /google\.com/.test(action) is satisfied by
  // e.g. `http://169.254.169.254/?x=google.com`, so a malicious site could use
  // this "Drive confirm" path to redirect our server-side fetch anywhere,
  // including cloud metadata endpoints. Only follow it when the action's actual
  // host is Google's.
  let host: string;
  try {
    host = new URL(action.replace(/&amp;/g, '&')).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== 'drive.google.com' && host !== 'docs.google.com' && !host.endsWith('.google.com')) return null;
  const params = new URLSearchParams();
  const inputRe = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html))) params.set(m[1], m[2].replace(/&amp;/g, '&'));
  if (!params.has('id')) return null;
  return `${action.replace(/&amp;/g, '&')}?${params.toString()}`;
}

export async function classifyMenuFromPdf(
  pdfUrl: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  try {
    // Share links (Google Drive /view, Dropbox ?dl=0) serve an HTML viewer,
    // not the file — rewrite them to a direct download first. Drive may still
    // answer the first request with a virus-scan interstitial, so try each
    // candidate URL in turn (see documentUrlCandidates).
    const candidates = documentUrlCandidates(pdfUrl);
    let buffer: ArrayBuffer | null = null;
    let blocked: MenuAccessBlockedError | null = null;
    for (const candidate of candidates) {
      try {
        buffer = await fetchDocument(candidate);
      } catch (err) {
        if (err instanceof MenuAccessBlockedError) {
          // Remember it, but keep trying the other URLs and the reader — being
          // refused one route doesn't mean every route is closed.
          blocked = err;
          continue;
        }
        throw err;
      }
      if (buffer) break;
    }
    // Verify it really is a PDF BEFORE spending a call. Anything else (a viewer
    // page, a login wall, an error page) would be posted as application/pdf and
    // rejected by the API — a guaranteed-fail call we would still be billed for.
    if (!buffer) {
      // Last resort before giving up on a menu we KNOW exists: ask the reader
      // for it. tofuvegan.com serves a real 8-page menu PDF that opens in a
      // browser but refuses our request, and the reader fetches from different
      // infrastructure and returns extracted text. Reading it as text is just
      // as good — a menu is words either way.
      //
      // Try EVERY candidate, not just the URL we were handed: for Google Drive
      // the share link renders a JS viewer shell with no dish text in it, while
      // the direct-download URL gives the reader the actual document.
      for (const candidate of Array.from(new Set([pdfUrl, ...candidates]))) {
        // A long budget on purpose: this path only runs for documents, and the
        // one that sent us here is a 26 MB PDF the reader needs ~a minute to
        // fetch and extract. The default 25s page budget gave up on it.
        const viaReader = await readPage(candidate, DOCUMENT_TIMEOUT_MS).catch(() => null);
        if (viaReader && viaReader.markdown.length >= 200) {
          console.error(`[pdf] direct fetch refused; extracted via ${viaReader.provider}: ${candidate}`);
          return classifyMenuWithAI(viaReader.markdown, restaurantName, modelOverride);
        }
      }
      // Note the reader is NOT a safety net for large files: verified free on
      // 2026-08-06 (run #41), Firecrawl answered HTTP 408 on tofuvegan.com's
      // 26 MB PDF even given a full 85s. Big documents are handled above, by
      // uploading rather than inlining — not here.
      // Every route refused, and at least one said so explicitly. Surface that
      // rather than letting it collapse into "this restaurant has no menu".
      if (blocked) throw blocked;
      return null;
    }

    // Too big to base64 into the request body, but fine as raw bytes: upload it
    // and reference the file by id. This is the only route left for a 20-32 MB
    // menu — the reader cannot parse files this size (proven, run #41).
    if (buffer.byteLength > INLINE_PDF_BYTES) {
      const fileId = await uploadDocument(buffer, filenameFor(pdfUrl));
      if (fileId) {
        return classifyMenuFromDocumentSource({ type: 'file', file_id: fileId }, restaurantName, modelOverride, [
          FILES_API_BETA,
        ]);
      }
      console.error(`[pdf] upload failed for ${pdfUrl} — no route left for a ${buffer.byteLength}-byte document`);
      return null;
    }

    const pdfBase64 = Buffer.from(buffer).toString('base64');
    return classifyMenuFromPdfBuffer(pdfBase64, restaurantName, modelOverride);
  } catch (err) {
    if (isBillingError(err)) throw err;
    if (err instanceof AICallError) throw err; // carries usage — must not be swallowed
    // "We were refused" must not be flattened into "there is no menu". The
    // refusal was raised deliberately a few lines above and this catch was
    // quietly discarding it: run #43 logged Google's "the owner hasn't given
    // you permission to download this file" four times, then told the user the
    // restaurant may not publish a menu online.
    if (err instanceof MenuAccessBlockedError) throw err;
    return null;
  }
}

/**
 * Same as classifyMenuFromPdf but for PDF data already in hand (e.g. an
 * admin's manually uploaded PDF, with no URL to fetch). Split out so both
 * entry points share one implementation instead of the upload path
 * duplicating the API call.
 */
export async function classifyMenuFromPdfBuffer(
  pdfBase64: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  return classifyMenuFromDocumentSource(
    { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    restaurantName,
    modelOverride
  );
}

/** Beta gate for the Files API. Required on both the upload and any message
 *  that references an uploaded file by id. */
const FILES_API_BETA = 'files-api-2025-04-14';

/** A readable filename for the upload — it shows up in API logs, and "menu.pdf"
 *  for every restaurant makes those logs useless. */
export function filenameFor(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const clean = base.replace(/[^\w.-]/g, '').slice(-80);
    if (clean) return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`;
  } catch {}
  return 'menu.pdf';
}

/**
 * Upload a document and get a file id back, for PDFs too large to inline.
 *
 * Hand-rolled rather than via the SDK: the pinned SDK (0.27.x) predates the
 * Files API entirely, and bumping it to reach one endpoint would put a major
 * dependency change on the menu-extraction critical path for no other gain.
 * A single multipart POST is the smaller risk.
 *
 * Returns null on any failure — the caller still has the reader fallback and
 * the "we were refused" path below it.
 */
async function uploadDocument(buffer: ArrayBuffer, filename: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    const res = await fetch('https://api.anthropic.com/v1/files', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': FILES_API_BETA,
      },
      body: form,
      // A 26 MB upload is not instant, but it must still fit inside the request
      // that started it — an unclamped 120s here is twice the function's cap.
      signal: AbortSignal.timeout(clampTimeout(120000)),
    });
    if (!res.ok) {
      console.error(`[pdf] Files API upload HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) return null;
    console.error(`[pdf] uploaded ${buffer.byteLength} bytes as ${json.id}`);
    return json.id;
  } catch (err) {
    console.error(`[pdf] Files API upload threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * One implementation for every way a PDF can reach the model — inline base64 or
 * an uploaded file id. Kept as one function on purpose: this is the path where
 * usage has twice been dropped, and a second copy is a second place to drop it.
 */
async function classifyMenuFromDocumentSource(
  // SDK 0.27.x types don't include 'document' yet, but the API supports it.
  // eslint-disable-next-line
  source: any,
  restaurantName?: string,
  modelOverride?: string,
  betas?: string[]
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  try {
    const model = modelOverride ?? EXTRACTION_MODEL;
    const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';

    // eslint-disable-next-line
    const pdfContent: any[] = [
      { type: 'document', source },
      {
        type: 'text',
        text: `${nameHint}Analyse this restaurant menu PDF and classify all food dishes. Return ONLY JSON.`,
      },
    ];

    const message = await callClaude(
      {
        model,
        max_tokens: 8192, // large menus (50+ dishes) overflow 4096 and truncate the JSON
        system: CACHED_SYSTEM,
        messages: [{ role: 'user', content: pdfContent }],
      },
      betas?.length ? { headers: { 'anthropic-beta': betas.join(',') } } : undefined
    );

    const usage = usageOf(message);
    const content = message.content[0];
    if (content.type !== 'text') throw new AICallError('Unexpected AI response type', usage);
    if (message.stop_reason === 'max_tokens') {
      throw new AICallError('AI response hit the output limit before finishing the PDF menu.', usage, true);
    }

    const text = content.text.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const jsonText = jsonMatch[1]?.trim() ?? text;

    let menu: ClassifiedMenu;
    try {
      menu = JSON.parse(jsonText) as ClassifiedMenu;
    } catch {
      throw new AICallError('AI returned invalid JSON from the PDF.', usage);
    }

    if (!menu.sections || menu.sections.length === 0) {
      // empty=true: the model read the PDF and found no menu — not a malfunction.
      throw new AICallError('No menu found in the PDF.', usage, false, true);
    }

    return { menu: stripDrinksAndHeaders(menu), usage };
  } catch (err) {
    if (isBillingError(err)) throw err;
    if (err instanceof AICallError) throw err; // carries usage — never swallow
    return null;
  }
}

/** Exported for prompt-regression tests. */
export function buildVerifyPrompt(
  dishes: Array<{ section: string; name: string; description?: string; classification: string; confidence: number }>,
  restaurantName?: string
): string {
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n` : '';
  const list = dishes
    .map(
      (d, i) =>
        `${i}. [${d.section}] "${d.name}"${d.description ? ` — ${d.description}` : ''} → currently ${d.classification} (confidence ${d.confidence})`
    )
    .join('\n');

  return `${nameHint}You are auditing dietary labels for a restaurant app whose vegetarian and vegan users trust it to keep meat, poultry, fish, and seafood off their plate. A wrong "vegetarian" or "vegan" label is a serious failure. Below are dishes a first-pass classifier labeled vegan, vegetarian, or unknown. For EACH dish, confirm or correct the label:

- "vegan": only plant-based ingredients, no animal products whatsoever
- "vegetarian": no meat, poultry, fish, or seafood, but may contain dairy, eggs, or honey
- "neither": contains meat, poultry, fish, or seafood — including hidden animal ingredients
- "unknown": genuinely unclear from the name and description

Watch for hidden animal ingredients: fish sauce, oyster sauce, or worcestershire sauce (Asian and Italian dishes); meat or fish stock in soups, risottos, and stews; anchovies in Caesar dressing or puttanesca; gelatin in desserts and panna cotta; lard or suet in pastry; prawn crackers or prawn toast. Be conservative: if a dish very likely contains one of these, downgrade the label and lower the confidence rather than giving it the benefit of the doubt.

ONE EXCEPTION to that conservatism — dishes where the DINER CHOOSES the protein or topping ("Pad Thai — choice of tofu, chicken or prawn", "roll with a choice of cheese, ham or salami", "toastie, optional ham"). If a vegetarian option is genuinely selectable, KEEP the vegetarian/vegan label rather than downgrading: the diner can order it without meat. Say which choice makes it work in the "reason" (e.g. "veg if ordered with tofu"). Downgrade to "neither" only when every available option contains meat, poultry or fish.

Dishes:
${list}

Return ONLY a JSON array with one object per dish, in index order:
[{"index": 0, "classification": "vegan|vegetarian|neither|unknown", "confidence": 0.85, "reason": "brief, under 12 words"}]`;
}

const VALID_CLASSIFICATIONS = new Set(['vegan', 'vegetarian', 'neither', 'unknown']);

/**
 * Sonnet second opinion on the trust-critical labels. Haiku does the cheap
 * extraction; this pass re-checks ONLY dishes labeled vegan/vegetarian/unknown
 * (compact text, no images/PDFs) so the strong model has the final say on what
 * users filter by, at ~a cent per menu. Never throws — on any failure the
 * original menu is returned unchanged so a finished analysis is never lost.
 */
export async function verifyVegClassifications(
  menu: ClassifiedMenu,
  restaurantName?: string
): Promise<{ menu: ClassifiedMenu; usage?: AIUsage }> {
  // Single early return covers all four call sites (analyze route, extractAndMerge,
  // and both admin add-menu paths) without changing the returned shape.
  if (!VERIFY_VEG_ENABLED) return { menu };

  const flagged: Array<{ s: number; d: number }> = [];
  menu.sections.forEach((sec, s) =>
    sec.dishes.forEach((dish, d) => {
      if (dish.classification === 'vegan' || dish.classification === 'vegetarian' || dish.classification === 'unknown') {
        flagged.push({ s, d });
      }
    })
  );
  if (flagged.length === 0) return { menu };

  // Bound the audit (and its cost) on pathological menus.
  const audit = flagged.slice(0, 100);
  const dishes = audit.map(({ s, d }) => {
    const dish = menu.sections[s].dishes[d];
    return {
      section: menu.sections[s].name,
      name: dish.name,
      description: dish.description ?? undefined,
      classification: dish.classification,
      confidence: dish.confidence,
    };
  });

  try {
    const message = await callClaude({
      model: VERIFICATION_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildVerifyPrompt(dishes, restaurantName) }],
    });

    const content = message.content[0];
    if (content.type !== 'text') return { menu };

    const raw = content.text.trim();
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
    const parsed = JSON.parse(jsonMatch[1]?.trim() ?? raw) as Array<{
      index: number;
      classification: string;
      confidence: number;
      reason?: string;
    }>;

    const verified: ClassifiedMenu = structuredClone(menu);
    for (const p of parsed) {
      const loc = audit[p.index];
      if (!loc || !VALID_CLASSIFICATIONS.has(p.classification)) continue;
      const dish = verified.sections[loc.s].dishes[loc.d];
      if (p.classification !== dish.classification && p.reason) dish.reason = p.reason;
      dish.classification = p.classification as DietaryClassification;
      if (typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1) dish.confidence = p.confidence;
    }

    const tokensIn = message.usage.input_tokens;
    const tokensOut = message.usage.output_tokens;
    return {
      menu: verified,
      usage: { model: VERIFICATION_MODEL, tokensIn, tokensOut, costUsd: calcCost(VERIFICATION_MODEL, tokensIn, tokensOut) },
    };
  } catch (err) {
    // A failed audit must not lose a finished analysis — keep the Haiku labels.
    console.error('[verify] dietary double-check failed:', err instanceof Error ? err.message : err);
    return { menu };
  }
}

export function countFoodItems(menu: ClassifiedMenu): number {
  return menu.sections.reduce((total, s) => total + s.dishes.length, 0);
}

export function buildVeganKeywordSet(): Set<string> {
  return new Set(DIETARY_FILTERS.vegan.markers.map((m) => m.toLowerCase()));
}

export function buildVegetarianKeywordSet(): Set<string> {
  return new Set(DIETARY_FILTERS.vegetarian.markers.map((m) => m.toLowerCase()));
}
