import { NextRequest } from 'next/server';
import { z } from 'zod';
import { scrapeRestaurant } from '@/lib/scraper';
import { classifyMenuWithAI, classifyMenuFromImages, classifyMenuFromPdf, countFoodItems } from '@/lib/ai';
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

        const hasAnyContent =
          (scrapeResult.menuText && scrapeResult.menuText.length >= 100) ||
          (scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0) ||
          (scrapeResult.menuImages && scrapeResult.menuImages.length > 0);

        if (!hasAnyContent) {
          const msg = scrapeResult.warning ?? "We opened the website but couldn't find a menu on it — some restaurants don't list their menu online. If you found a menu link we missed, paste that directly and we'll try again.";
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        // Step 3: AI classification — text → PDF → image fallback chain
        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 3, totalSteps: 4 });
        let menu;
        let aiUsage;
        try {
          const hasText = scrapeResult.menuText && scrapeResult.menuText.length >= 100;
          const hasPdfs = scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0;
          const hasImages = scrapeResult.menuImages && scrapeResult.menuImages.length > 0;
          const MIN_FOOD_ITEMS = 7;

          if (hasPdfs && !hasText) {
            // Primary: PDF document
            send({ type: 'progress', step: 'Reading menu PDF with AI...', stepNumber: 3, totalSteps: 4 });
            const pdfResult = await classifyMenuFromPdf(scrapeResult.menuPdfUrls![0], scrapeResult.title);
            if (pdfResult && countFoodItems(pdfResult.menu) >= MIN_FOOD_ITEMS) {
              menu = pdfResult.menu;
              aiUsage = pdfResult.usage;
            } else if (hasImages) {
              // Fallback to images if PDF gave too few items
              send({ type: 'progress', step: 'Reading menu image with AI vision...', stepNumber: 3, totalSteps: 4 });
              const imgResult = await classifyMenuFromImages(scrapeResult.menuImages!, scrapeResult.title);
              if (imgResult && countFoodItems(imgResult.menu) >= MIN_FOOD_ITEMS) {
                menu = imgResult.menu;
                aiUsage = imgResult.usage;
              } else {
                // Use whichever gave more items
                const best = pdfResult && (!imgResult || countFoodItems(pdfResult.menu) >= countFoodItems(imgResult?.menu ?? { sections: [] })) ? pdfResult : imgResult;
                if (!best) throw new Error("We found a menu PDF and some images but couldn't extract dishes from either. Try pasting the menu page URL instead.");
                menu = best.menu;
                aiUsage = best.usage;
              }
            } else {
              if (!pdfResult) throw new Error("We found a menu PDF but couldn't extract the dishes from it. Try pasting the main menu page URL instead.");
              menu = pdfResult.menu;
              aiUsage = pdfResult.usage;
            }
          } else if (!hasText && hasImages) {
            // Primary: image vision
            send({ type: 'progress', step: 'Reading menu image with AI vision...', stepNumber: 3, totalSteps: 4 });
            const imageResult = await classifyMenuFromImages(scrapeResult.menuImages!, scrapeResult.title);
            if (!imageResult) throw new Error("We found menu images but couldn't read them clearly. Try pasting a page where the menu is written out as text.");
            menu = imageResult.menu;
            aiUsage = imageResult.usage;
          } else if (hasText) {
            // Primary: HTML text
            const result = await classifyMenuWithAI(scrapeResult.menuText, scrapeResult.title);
            menu = result.menu;
            aiUsage = result.usage;

            // If text gave too few items, try PDF or image fallback
            if (countFoodItems(menu) < MIN_FOOD_ITEMS) {
              if (hasPdfs) {
                send({ type: 'progress', step: 'Checking menu PDF for more dishes...', stepNumber: 3, totalSteps: 4 });
                const pdfResult = await classifyMenuFromPdf(scrapeResult.menuPdfUrls![0], scrapeResult.title);
                if (pdfResult && countFoodItems(pdfResult.menu) > countFoodItems(menu)) {
                  menu = pdfResult.menu;
                  aiUsage = pdfResult.usage;
                }
              } else if (hasImages && countFoodItems(menu) < MIN_FOOD_ITEMS) {
                send({ type: 'progress', step: 'Reading menu image with AI vision...', stepNumber: 3, totalSteps: 4 });
                const imgResult = await classifyMenuFromImages(scrapeResult.menuImages!, scrapeResult.title);
                if (imgResult && countFoodItems(imgResult.menu) > countFoodItems(menu)) {
                  menu = imgResult.menu;
                  aiUsage = imgResult.usage;
                }
              }
            }
          } else {
            throw new Error("We loaded the page but couldn't find any menu content — no text, PDF, or images. Try pasting a direct link to the menu page.");
          }

          // Final guard: if we still have very few items, it's likely a parsing failure
          if (countFoodItems(menu) < MIN_FOOD_ITEMS && countFoodItems(menu) === 0) {
            throw new Error("We couldn't find any dishes listed on this page — it's possible the restaurant doesn't have their menu online. If you spotted a menu link we missed, paste it directly and we'll try again.");
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
