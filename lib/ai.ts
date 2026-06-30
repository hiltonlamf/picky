import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedMenu } from '@/types';
import { DIETARY_FILTERS } from './dietary-config';

// Pricing per million tokens (as of claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-8)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-8':           { input: 5.00, output: 25.00 },
};

// Model tiers (reliability-first): cheap discovery, strong extraction, escalation on retry.
export const DISCOVERY_MODEL = 'claude-haiku-4-5-20251001';
export const EXTRACTION_MODEL = 'claude-sonnet-4-6';
export const ESCALATION_MODEL = 'claude-opus-4-8';

export type AIUsage = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model] ?? { input: 3.00, output: 15.00 };
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a dietary classifier specializing in vegetarian and vegan restaurant menus.

Your task: analyse a restaurant menu and classify each FOOD dish accurately.

CRITICAL — WHAT TO INCLUDE vs. EXCLUDE:
- INCLUDE: all individual food dishes — starters, mains, sides, desserts, sharing plates, etc.
- EXCLUDE completely (do not add to any section): ALL beverages — wines, beers, spirits, cocktails, soft drinks, juices, coffee, tea, water, smoothies, or any drink item. Most users assume drinks are vegetarian; listing them wastes space.
- EXCLUDE: menu section headers used as dish names (e.g. "Daily Dim Sum Menu", "Today's Specials", "Set Menu €35 per person", "Starter Selection"). These are categories, not individual dishes.
- EXCLUDE: non-dish text like opening hours, allergen notices, chef's notes, reservation policies.
- If a section contains ONLY drinks, omit that entire section from the output.

CRITICAL — MULTI-LANGUAGE / BILINGUAL MENUS:
- Some menus list each dish in two languages (e.g. French and English, or Spanish and English), either side by side or stacked. Output each dish EXACTLY ONCE — never as two separate entries. Use the dish's primary/original language for the "name" and put any translation in the description.
- Do not let a translated duplicate inflate the dish count.

Classification rules:
- "vegan": dish contains only plant-based ingredients with no animal products whatsoever
- "vegetarian": dish contains no meat, poultry, or fish, but may contain dairy, eggs, or honey
- "neither": dish contains meat, poultry, fish, or seafood
- "unknown": classification is genuinely unclear (e.g. "soup of the day" with no ingredient info)

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

Always include a brief "reason" explaining your classification decision.

Return ONLY valid JSON in this exact structure:
{
  "restaurantName": "string or null",
  "language": "detected language, e.g. 'English', 'French'",
  "sections": [
    {
      "name": "section name e.g. Starters, Mains, Desserts",
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

function buildPrompt(menuText: string, restaurantName?: string): string {
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';
  return `${nameHint}Analyse this restaurant menu and classify all dishes. Return ONLY JSON.\n\nMenu content:\n\n${menuText.slice(0, 30000)}`;
}

export async function classifyMenuWithAI(
  menuText: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  // Reliability-first: default extraction to the strong model regardless of
  // language; an explicit override (e.g. escalation) wins.
  const model = modelOverride ?? EXTRACTION_MODEL;

  const message = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(menuText, restaurantName) }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected AI response type');

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;

  let menu: ClassifiedMenu;
  try {
    menu = JSON.parse(jsonText) as ClassifiedMenu;
  } catch {
    throw new Error('AI returned invalid JSON. Please try again.');
  }

  const tokensIn = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  const usage: AIUsage = { model, tokensIn, tokensOut, costUsd: calcCost(model, tokensIn, tokensOut) };

  return { menu: stripDrinksAndHeaders(menu), usage };
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

/** Detect image type from magic bytes (more reliable than Content-Type). */
function sniffImageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  return null;
}

export async function classifyMenuFromImages(
  imageUrls: string[],
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  const downloaded = await Promise.all(imageUrls.map(downloadImageAsBase64));
  const images = downloaded.filter(Boolean) as Array<{ data: string; mediaType: string }>;
  if (images.length === 0) return null;

  const model = modelOverride ?? EXTRACTION_MODEL;
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';

  const message = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
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
            text: `${nameHint}Look at the image(s) above. Find any restaurant menu with dish listings and classify every dish. If no menu is visible, return an empty sections array.\n\nReturn ONLY JSON.`,
          },
        ],
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') return null;

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;

  let menu: ClassifiedMenu;
  try {
    menu = JSON.parse(jsonText) as ClassifiedMenu;
  } catch {
    return null;
  }

  if (!menu.sections || menu.sections.length === 0) return null;

  const tokensIn = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  const usage: AIUsage = { model, tokensIn, tokensOut, costUsd: calcCost(model, tokensIn, tokensOut) };

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

/**
 * Cheap Haiku pass that turns raw menu-source candidates into human-friendly,
 * de-duplicated menu labels and flags which are genuinely distinct menus.
 * Used by the discovery phase to drive the multi-menu picker.
 */
export async function labelMenuCandidates(
  candidates: Array<{ ref: string; hint: string; type: string }>,
  restaurantName?: string
): Promise<Array<{ ref: string; label: string; isDistinctMenu: boolean }>> {
  if (candidates.length === 0) return [];
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n` : '';
  const list = candidates
    .map((c, i) => `${i}. [${c.type}] ${c.hint || c.ref}`)
    .join('\n');

  const message = await anthropic.messages.create({
    model: DISCOVERY_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${nameHint}Below is a list of candidate menu sources found on a restaurant website (each is a link, PDF, image, or the page text itself). For EACH item, give a short human label describing what menu it is (e.g. "Dinner Menu", "Wine List", "Lunch", "Brunch", "À la carte", "Set Menu"), and decide if it is a DISTINCT food/drink menu a diner would choose between.

Mark isDistinctMenu = false for: navigation/about/contact/gallery/booking/gift-voucher links, social media, duplicates of another item, or anything that is not actually a menu.

Candidates:
${list}

Return ONLY a JSON array, one object per candidate index, in order:
[{"index": 0, "label": "Dinner Menu", "isDistinctMenu": true}, ...]`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') return candidates.map((c) => ({ ref: c.ref, label: c.hint || 'Menu', isDistinctMenu: true }));

  const text = content.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonText = jsonMatch[1]?.trim() ?? text;
  try {
    const parsed = JSON.parse(jsonText) as Array<{ index: number; label: string; isDistinctMenu: boolean }>;
    return candidates.map((c, i) => {
      const match = parsed.find((p) => p.index === i);
      return {
        ref: c.ref,
        label: match?.label?.trim() || c.hint || 'Menu',
        isDistinctMenu: match?.isDistinctMenu ?? true,
      };
    });
  } catch {
    return candidates.map((c) => ({ ref: c.ref, label: c.hint || 'Menu', isDistinctMenu: true }));
  }
}

export async function analysePageForMenu(
  pageText: string,
  pageUrl: string
): Promise<{ isMenu: boolean; suggestedLinks: string[] }> {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Does this webpage contain a restaurant menu with dish listings?

Page URL: ${pageUrl}
Content snippet: ${pageText.slice(0, 3000)}

Reply with JSON only: {"isMenu": true/false, "suggestedLinks": ["url1", "url2"]}
Include suggestedLinks only if isMenu is false and you can see links to menu pages in the content.`,
      },
    ],
  });

  const text = (message.content[0] as { type: string; text: string }).text.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { isMenu: true, suggestedLinks: [] };
  }
}

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
    .filter((s) => !isDrinkSectionName(s.name))
    .map((s) => ({
      ...s,
      dishes: s.dishes.filter((d) => {
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
    }))
    .filter((s) => s.dishes.length > 0);

  return { ...menu, sections: cleaned };
}

export async function classifyMenuFromPdf(
  pdfUrl: string,
  restaurantName?: string,
  modelOverride?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  try {
    const res = await fetch(pdfUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    // Skip files > 20 MB
    if (buffer.byteLength > 20 * 1024 * 1024) return null;

    const pdfBase64 = Buffer.from(buffer).toString('base64');
    const model = modelOverride ?? EXTRACTION_MODEL;
    const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';

    // SDK 0.27.x types don't include 'document' yet, but the API supports it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfContent: any[] = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
      },
      {
        type: 'text',
        text: `${nameHint}Analyse this restaurant menu PDF and classify all food dishes. Return ONLY JSON.`,
      },
    ];

    const message = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: pdfContent }],
    });

    const content = message.content[0];
    if (content.type !== 'text') return null;

    const text = content.text.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const jsonText = jsonMatch[1]?.trim() ?? text;

    let menu: ClassifiedMenu;
    try {
      menu = JSON.parse(jsonText) as ClassifiedMenu;
    } catch {
      return null;
    }

    if (!menu.sections || menu.sections.length === 0) return null;

    const tokensIn = message.usage.input_tokens;
    const tokensOut = message.usage.output_tokens;
    const usage: AIUsage = { model, tokensIn, tokensOut, costUsd: calcCost(model, tokensIn, tokensOut) };

    return { menu: stripDrinksAndHeaders(menu), usage };
  } catch {
    return null;
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
