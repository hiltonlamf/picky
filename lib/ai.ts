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

Your task: analyse a restaurant menu and classify each dish accurately.

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

  return { menu, usage };
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

  return { menu, usage };
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

export function buildVeganKeywordSet(): Set<string> {
  return new Set(DIETARY_FILTERS.vegan.markers.map((m) => m.toLowerCase()));
}

export function buildVegetarianKeywordSet(): Set<string> {
  return new Set(DIETARY_FILTERS.vegetarian.markers.map((m) => m.toLowerCase()));
}
