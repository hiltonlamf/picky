import { NextRequest } from 'next/server';
import { z } from 'zod';
import { scrapeRestaurant } from '@/lib/scraper';
import { classifyMenuWithAI, classifyMenuFromImages } from '@/lib/ai';
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

const schema = z.object({ url: z.string().url('Please provide a valid URL') });

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

        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          send({ type: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid URL' });
          return close();
        }

        const { url } = parsed.data;

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

        // Step 1: Check cache
        send({ type: 'progress', step: 'Checking our database...', stepNumber: 1, totalSteps: 4 });
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

        // Step 2: Scrape
        send({ type: 'progress', step: 'Fetching the restaurant page...', stepNumber: 2, totalSteps: 4 });
        let scrapeResult;
        try {
          scrapeResult = await scrapeRestaurant(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not fetch this page';
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        if (scrapeResult.warning && !scrapeResult.menuText) {
          await markRestaurantError(restaurantId, scrapeResult.warning);
          send({ type: 'error', error: scrapeResult.warning });
          return close();
        }

        // Step 3: AI classification (text or image fallback)
        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 3, totalSteps: 4 });
        let menu;
        let aiUsage;
        try {
          const hasText = scrapeResult.menuText && scrapeResult.menuText.length >= 100;
          const hasImages = scrapeResult.menuImages && scrapeResult.menuImages.length > 0;

          if (!hasText && hasImages) {
            send({ type: 'progress', step: 'Reading menu image with AI vision...', stepNumber: 3, totalSteps: 4 });
            const imageResult = await classifyMenuFromImages(scrapeResult.menuImages!, scrapeResult.title);
            if (!imageResult) throw new Error("Couldn't extract menu dishes from the images on this page.");
            menu = imageResult.menu;
            aiUsage = imageResult.usage;
          } else if (hasText) {
            const result = await classifyMenuWithAI(scrapeResult.menuText, scrapeResult.title);
            menu = result.menu;
            aiUsage = result.usage;
          } else {
            throw new Error("We couldn't find any menu content on this page. Try pasting the restaurant's direct menu URL.");
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

        // Step 4: Save
        send({ type: 'progress', step: 'Saving your results...', stepNumber: 4, totalSteps: 4 });
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
