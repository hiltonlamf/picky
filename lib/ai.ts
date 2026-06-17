import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedMenu } from '@/types';
import { DIETARY_FILTERS } from './dietary-config';

// Pricing per million tokens (as of claude-haiku-4-5 / claude-sonnet-4-6)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};

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

function detectLanguage(text: string): 'simple' | 'complex' {
  const nonEnglishPatterns = [
    /\b(avec|sans|et|les|des|du|de la|une|un|le|la)\b/i, // French
    /\b(con|sin|y|los|las|el|la|un|una|del)\b/i,          // Spanish
    /\b(con|senza|e|gli|le|il|la|un|una|dello|della)\b/i, // Italian
    /\b(mit|ohne|und|die|der|das|ein|eine|dem|den)\b/i,   // German
    /\b(met|zonder|en|de|het|een|van)\b/i,                 // Dutch
  ];

  const matchCount = nonEnglishPatterns.filter((p) => p.test(text)).length;
  return matchCount >= 2 ? 'complex' : 'simple';
}

function buildPrompt(menuText: string, restaurantName?: string): string {
  const nameHint = restaurantName ? `Restaurant: ${restaurantName}\n\n` : '';
  return `${nameHint}Analyse this restaurant menu and classify all dishes. Return ONLY JSON.\n\nMenu content:\n\n${menuText.slice(0, 30000)}`;
}

export async function classifyMenuWithAI(
  menuText: string,
  restaurantName?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  const complexity = detectLanguage(menuText);

  const model =
    complexity === 'complex'
      ? 'claude-sonnet-4-6'
      : 'claude-haiku-4-5-20251001';

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

    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const mediaType = contentType.split(';')[0].trim();
    const data = Buffer.from(buffer).toString('base64');
    return { data, mediaType };
  } catch {
    return null;
  }
}

export async function classifyMenuFromImages(
  imageUrls: string[],
  restaurantName?: string
): Promise<{ menu: ClassifiedMenu; usage: AIUsage } | null> {
  const downloaded = await Promise.all(imageUrls.map(downloadImageAsBase64));
  const images = downloaded.filter(Boolean) as Array<{ data: string; mediaType: string }>;
  if (images.length === 0) return null;

  const model = 'claude-sonnet-4-6';
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

/**
 * Given all links on a restaurant page, asks Claude Haiku which ones lead
 * to the menu. Replaces keyword matching with LLM understanding so unusual
 * link text like "Asti" or "Our Story" is correctly handled.
 */
export async function discoverMenuUrls(
  pageLinks: Array<{ href: string; text: string }>,
  embedSrcs: string[],
  pageUrl: string,
  pageTitle: string
): Promise<{ pdfUrls: string[]; menuPageUrls: string[] }> {
  if (pageLinks.length === 0 && embedSrcs.length === 0) {
    return { pdfUrls: [], menuPageUrls: [] };
  }

  // Deduplicate and cap to keep the prompt small
  const seen = new Set<string>();
  const uniqueLinks = pageLinks.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  }).slice(0, 80);

  const linkList = uniqueLinks
    .map((l) => `- [${(l.text.trim() || '(no text)').slice(0, 60)}](${l.href})`)
    .join('\n');

  const embedPart = embedSrcs.length > 0
    ? `\nEmbedded/iframe resources:\n${embedSrcs.map((s) => `- ${s}`).join('\n')}`
    : '';

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Restaurant website: ${pageUrl}
Page title: ${pageTitle}

All links on this page:
${linkList}${embedPart}

Which URLs lead to the food menu? Return:
- "pdfUrls": any PDF file that is a menu document
- "menuPageUrls": HTML pages that show the food menu, including restaurant section or location pages (e.g. /asti/, /taverna/) — they usually contain a menu even if the link text doesn't say "menu"

Exclude: social media, reservations, contact, about us, blog, privacy, home page.

Reply with JSON only: {"pdfUrls": ["..."], "menuPageUrls": ["..."]}`,
    }],
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/) ?? [null];
  try {
    const result = JSON.parse(jsonMatch[0] ?? '{}') as Record<string, unknown>;
    return {
      pdfUrls: Array.isArray(result.pdfUrls) ? (result.pdfUrls as unknown[]).filter((u): u is string => typeof u === 'string') : [],
      menuPageUrls: Array.isArray(result.menuPageUrls) ? (result.menuPageUrls as unknown[]).filter((u): u is string => typeof u === 'string') : [],
    };
  } catch {
    return { pdfUrls: [], menuPageUrls: [] };
  }
}

const AGENTIC_SYSTEM_PROMPT = `You are a dietary classifier specializing in vegetarian and vegan restaurant menus.

GOAL: Find the complete restaurant menu and classify every food dish.

TOOLS:
- web_search: search the web for this restaurant's menu
- fetch_url: fetch the full text content of a specific URL

APPROACH — work through these steps in order:
1. Read any attached PDF documents — they usually contain the full menu
2. Read any attached menu images — extract all dish text visible
3. Read the provided page text — look for dish listings
4. If content is missing, minimal, or clearly not a menu (nav/about/contact), use web_search:
   - Search "[restaurant name] menu" or "[domain] menu"
   - When you find a specific menu page URL in results, use fetch_url to get its full content
   - Try fetch_url on the restaurant's own domain first (e.g. camdenkitchen.ie/a-la-carte-menu)
5. If the first search is insufficient, try different queries
6. Never return zero dishes without trying web_search + fetch_url

WHAT TO INCLUDE vs. EXCLUDE:
- INCLUDE: all individual food dishes — starters, mains, sides, desserts, sharing plates, etc.
- EXCLUDE completely: ALL beverages — wines, beers, spirits, cocktails, soft drinks, juices, coffee, tea, water. Drinks waste space and most users assume they are vegetarian.
- EXCLUDE: menu section headers used as dish names ("Daily Dim Sum Menu", "Starter Selection", "Set Menu €35 per person")
- EXCLUDE: non-dish text like opening hours, allergen notices, chef's notes, reservation policies
- If a section contains ONLY drinks, omit that entire section from the output

Classification rules:
- "vegan": dish contains only plant-based ingredients with no animal products whatsoever
- "vegetarian": dish contains no meat, poultry, or fish, but may contain dairy, eggs, or honey
- "neither": dish contains meat, poultry, fish, or seafood
- "unknown": classification is genuinely unclear (e.g. "soup of the day" with no ingredient info)

Watch for hidden non-vegetarian ingredients:
- Fish sauce, oyster sauce, worcestershire sauce (often in Asian, Italian dishes)
- Beef/chicken/fish stock in soups, risottos, stews
- Anchovies in Caesar dressing, puttanesca sauce, some salads
- Gelatin in desserts, jellies, panna cotta
- Lard or suet in pastry
- Meat broths in "vegetable" soups

Confidence score (0.0 to 1.0):
- 0.9–1.0: explicit marker like "(v)", "(ve)", "vegan" on the menu, or unmistakably obvious
- 0.7–0.9: clear from ingredients listed, no ambiguity
- 0.5–0.7: likely based on dish name/type but some ingredients unstated
- 0.3–0.5: uncertain, could go either way
- 0.1–0.3: very uncertain, needs confirmation

Always include a brief "reason" explaining your classification decision.

Return ONLY valid JSON — no prose before or after:
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

async function downloadPdfAsDocumentBlock(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 20 * 1024 * 1024) return null;
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buffer).toString('base64') },
    };
  } catch {
    return null;
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_URL_TOOL = {
  name: 'fetch_url',
  description:
    'Fetches the text content of a URL. Use this to read a specific restaurant menu page after finding its URL via web_search.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Full URL to fetch (https://)' },
    },
    required: ['url'],
  },
};

async function fetchUrlContent(targetUrl: string): Promise<string | unknown[]> {
  try {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!res.ok) return `HTTP ${res.status} fetching ${targetUrl}`;

    const contentType = res.headers.get('content-type') ?? '';
    const looksLikePdf =
      contentType.includes('application/pdf') || targetUrl.toLowerCase().split('?')[0].endsWith('.pdf');

    if (looksLikePdf) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > 20 * 1024 * 1024) return `PDF at ${targetUrl} is too large (>20MB) to read.`;
      const data = Buffer.from(buffer).toString('base64');
      // Return PDF as a document block so Claude can read it natively
      return [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        { type: 'text', text: `PDF retrieved from ${targetUrl} — read it above and extract all menu dishes.` },
      ];
    }

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 20000) || 'No text content found.';
  } catch (err) {
    return `Failed to fetch ${targetUrl}: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
}

/**
 * Agentic classification with a full tool loop.
 * Claude has two tools: web_search (server-side, finds URLs) and fetch_url
 * (client-side, retrieves full page content). This handles blocked scrapers,
 * PDF menus, image menus, and any website structure without hardcoded logic.
 */
export async function classifyMenuAgentic(
  url: string,
  content: {
    text?: string;
    pdfUrls?: string[];
    imageUrls?: string[];
    title?: string;
  }
): Promise<{ menu: ClassifiedMenu; usage: AIUsage }> {
  // Download PDFs (up to 3)
  const pdfBlocks = (
    await Promise.all((content.pdfUrls ?? []).slice(0, 3).map(downloadPdfAsDocumentBlock))
  ).filter(Boolean);

  // Download images (up to 3)
  const imageRaw = (
    await Promise.all((content.imageUrls ?? []).slice(0, 3).map(downloadImageAsBase64))
  ).filter(Boolean) as Array<{ data: string; mediaType: string }>;
  const imageBlocks = imageRaw.map((img) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
      data: img.data,
    },
  }));

  // Build context text
  const lines: string[] = [`Restaurant URL: ${url}`];
  if (content.title) lines.push(`Page title: ${content.title}`);
  const hasContent =
    (content.text && content.text.length > 50) ||
    pdfBlocks.length > 0 ||
    imageBlocks.length > 0;
  if (content.text && content.text.length > 50) {
    lines.push(`\nPage content:\n${content.text.slice(0, 25000)}`);
  }
  if (!hasContent) {
    lines.push(
      "\nNote: The website could not be scraped (blocked or JS-only). Use web_search then fetch_url to find and read this restaurant's menu."
    );
  }
  lines.push('\nClassify all food dishes from this restaurant. Return ONLY JSON.');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userContent: any[] = [
    ...pdfBlocks,
    ...imageBlocks,
    { type: 'text', text: lines.join('\n') },
  ];

  const model = 'claude-sonnet-4-6';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: 'web_search_20260209', name: 'web_search' },
    FETCH_URL_TOOL,
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'user', content: userContent }];
  let totalIn = 0;
  let totalOut = 0;
  let responseText = '';

  // Agentic loop — up to 8 turns to handle web_search + fetch_url rounds
  for (let turn = 0; turn < 8; turn++) {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: AGENTIC_SYSTEM_PROMPT,
      tools,
      messages,
    });

    totalIn += msg.usage.input_tokens;
    totalOut += msg.usage.output_tokens;

    for (const block of msg.content) {
      if (block.type === 'text') responseText += block.text;
    }

    if (msg.stop_reason !== 'tool_use') break;

    // Collect tool calls — web_search is server-side (never appears as tool_use);
    // fetch_url is client-side and needs us to execute it.
    const toolUseBlocks = msg.content.filter(
      (b: { type: string }) => b.type === 'tool_use'
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>;

    messages.push({ role: 'assistant', content: msg.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        if (block.name === 'fetch_url') {
          const input = block.input as { url?: string };
          const fetched = input.url
            ? await fetchUrlContent(input.url)
            : 'No URL provided.';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { type: 'tool_result' as const, tool_use_id: block.id, content: fetched as any };
        }
        return { type: 'tool_result' as const, tool_use_id: block.id, content: '' };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  if (!responseText.trim()) {
    throw new Error('AI did not return a classification response. Please try again.');
  }

  // Extract JSON from potentially mixed text (Claude may add preamble before/after JSON)
  function extractJson(raw: string): string {
    // 1. Fenced code block
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) return fenced[1].trim();
    // 2. JSON object containing the expected "sections" key (handles preamble text)
    const withSections = raw.match(/(\{[\s\S]*?"sections"[\s\S]*\})/);
    if (withSections?.[1]) return withSections[1].trim();
    // 3. Any JSON object
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) return raw.slice(firstBrace, lastBrace + 1).trim();
    return raw.trim();
  }
  const jsonText = extractJson(responseText);

  let menu: ClassifiedMenu;
  try {
    menu = JSON.parse(jsonText) as ClassifiedMenu;
  } catch {
    throw new Error('AI returned invalid JSON. Please try again.');
  }

  if (!menu.sections) menu.sections = [];

  const usage: AIUsage = { model, tokensIn: totalIn, tokensOut: totalOut, costUsd: calcCost(model, totalIn, totalOut) };
  return { menu: stripDrinksAndHeaders(menu), usage };
}

export async function classifyMenuFromPdf(
  pdfUrl: string,
  restaurantName?: string
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
    const model = 'claude-sonnet-4-6';
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
