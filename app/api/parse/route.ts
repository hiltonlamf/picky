import { NextRequest } from 'next/server';
import { z } from 'zod';
import { scrapeRestaurant, resolveRestaurantNameToUrl } from '@/lib/scraper';
import { classifyMenuAgentic, countFoodItems } from '@/lib/ai';
import {
  findExistingRestaurant,
  resetRestaurantForReparse,
  createRestaurantRecord,
  saveClassifiedMenu,
  markRestaurantError,
} from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { STALENESS_DAYS } from '@/lib/dietary-config';
import type { ParseEvent } from '@/types';

export const maxDuration = 60;

const schema = z.object({ url: z.string().min(1, 'Please enter a restaurant name or URL') });

function looksLikeUrl(input: string): boolean {
  const t = input.trim();
  return t.startsWith('http://') || t.startsWith('https://') || (!t.includes(' ') && t.includes('.'));
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'https://' + trimmed;
  }
  return trimmed;
}

function sseEncoder() {
  const encoder = new TextEncoder();
  return (event: ParseEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function isFresh(lastScrapedAt: string | null | undefined): boolean {
  if (!lastScrapedAt) return false;
  const age = (Date.now() - new Date(lastScrapedAt).getTime()) / (1000 * 60 * 60 * 24);
  return age < STALENESS_DAYS;
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const encode = sseEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ParseEvent) => {
        try {
          controller.enqueue(encode(event));
        } catch {
          // stream may have been closed
        }
      };

      const close = () => {
        try {
          controller.close();
        } catch {}
      };

      try {
        // Parse & validate input
        let body: { url: string };
        try {
          body = await request.json();
        } catch {
          send({ type: 'error', error: 'Invalid request body' });
          return close();
        }

        if (typeof body.url === 'string') body.url = normalizeUrl(body.url);
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          send({ type: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid URL' });
          return close();
        }

        const input = parsed.data.url.trim();

        // Rate limiting
        const { allowed, remaining } = await checkRateLimit(ip);
        if (!allowed) {
          send({
            type: 'error',
            error: `You've reached the limit of ${5} searches per hour. Please try again later.`,
          });
          return close();
        }
        void remaining;

        // Resolve restaurant name → URL if the user typed a name instead of a URL
        let url: string;
        let stepBase: number;
        let totalSteps: number;

        if (!looksLikeUrl(input)) {
          stepBase = 1;
          totalSteps = 5;
          send({ type: 'progress', step: 'Finding restaurant website...', stepNumber: 1, totalSteps: 5 });
          const resolved = await resolveRestaurantNameToUrl(input);
          if (!resolved) {
            send({ type: 'error', error: `We couldn't find a website for "${input}". Try pasting the restaurant's URL directly.` });
            return close();
          }
          url = resolved;
        } else {
          stepBase = 0;
          totalSteps = 4;
          url = normalizeUrl(input);
        }

        // Step: Check cache
        send({ type: 'progress', step: 'Checking our database...', stepNumber: 1 + stepBase, totalSteps });
        const existing = await findExistingRestaurant(url).catch(() => null);

        if (existing?.status === 'done' && isFresh(existing.lastScrapedAt)) {
          send({ type: 'cached', restaurantId: existing.id });
          return close();
        }

        // Reuse existing record ID (any status) or create a fresh one
        let restaurantId = existing?.id ?? '';
        if (!restaurantId) {
          restaurantId = await createRestaurantRecord(url);
        } else {
          await resetRestaurantForReparse(restaurantId);
        }

        // Step: Scrape
        send({ type: 'progress', step: 'Fetching the restaurant page...', stepNumber: 2 + stepBase, totalSteps });
        let scrapeResult;
        try {
          scrapeResult = await scrapeRestaurant(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not fetch this page';
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        // Step: AI analysis — Claude reads all content and uses web_search if needed
        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 3 + stepBase, totalSteps });
        let menu;
        let aiUsage;
        try {
          const result = await classifyMenuAgentic(url, {
            text: scrapeResult.menuText,
            pdfUrls: scrapeResult.menuPdfUrls,
            imageUrls: scrapeResult.menuImages,
            title: scrapeResult.title,
          });
          menu = result.menu;
          aiUsage = result.usage;

          if (countFoodItems(menu) === 0) {
            throw new Error("We couldn't find any dishes for this restaurant. If the menu is on a separate page, try pasting that link directly.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'AI classification failed';
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        // If restaurant name not detected by AI, fall back to scraped title
        if (!menu.restaurantName && scrapeResult.title) {
          menu.restaurantName = scrapeResult.title;
        }

        // Step: Save
        send({ type: 'progress', step: 'Saving your results...', stepNumber: 4 + stepBase, totalSteps });
        await saveClassifiedMenu(
          restaurantId,
          scrapeResult.canonicalUrl,
          scrapeResult.menuUrl,
          menu,
          aiUsage
        );

        send({ type: 'result', restaurantId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
        send({ type: 'error', error: msg });
      }

      close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
