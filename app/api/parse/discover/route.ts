import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { scrapeRestaurant } from '@/lib/scraper';
import { discoverMenus } from '@/lib/menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext } from '@/lib/menu-extract';
import {
  findExistingRestaurant,
  resetRestaurantForReparse,
  createRestaurantRecord,
  saveClassifiedMenu,
  saveMenuCandidates,
  markRestaurantError,
  logUsage,
  logParseAttempt,
} from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { menuCategory } from '@/lib/telemetry';
import { checkRateLimit, getClientIp, hashIp } from '@/lib/rate-limit';
import { STALENESS_DAYS } from '@/lib/dietary-config';
import type { ParseEvent } from '@/types';

// Vercel Hobby caps functions at 60s. This route only scrapes + discovers
// (analysis is handed to the resumable /analyze endpoint), which fits.
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

      // Telemetry context — set once the URL is known so every terminal
      // outcome (including the outer catch) can log the attempt.
      const startedAt = Date.now();
      let attemptUrl: string | null = null;
      let attemptCategory: string | null = null;
      const logAttempt = (success: boolean, errorMessage?: string) => {
        if (!attemptUrl) return Promise.resolve();
        return logParseAttempt({
          url: attemptUrl,
          stage: 'discover',
          category: attemptCategory,
          success,
          errorMessage: errorMessage ?? null,
          durationMs: Date.now() - startedAt,
        });
      };
      const emitAnalysisCompleted = (success: boolean, dishCount?: number) =>
        captureServer(hashIp(ip), 'analysis_completed', {
          success,
          category: attemptCategory,
          duration_ms: Date.now() - startedAt,
          dish_count: dishCount ?? 0,
        });

      try {
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

        const { allowed } = await checkRateLimit(ip);
        if (!allowed) {
          send({ type: 'error', error: `You've reached the limit of 5 searches per hour. Please try again later.` });
          return close();
        }
        attemptUrl = url;

        // Cache check
        send({ type: 'progress', step: 'Checking our database...', stepNumber: 1, totalSteps: 4 });
        const existing = await findExistingRestaurant(url).catch(() => null);
        if (existing?.status === 'done' && isFresh(existing.lastScrapedAt)) {
          send({ type: 'cached', restaurantId: existing.id });
          return close();
        }

        let restaurantId = existing?.id ?? '';
        if (!restaurantId) {
          restaurantId = await createRestaurantRecord(url);
        } else {
          await resetRestaurantForReparse(restaurantId);
        }

        // Scrape
        send({ type: 'progress', step: 'Fetching the restaurant page...', stepNumber: 2, totalSteps: 4 });
        let scrapeResult;
        try {
          scrapeResult = await scrapeRestaurant(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not fetch this page';
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: msg });
          return close();
        }

        const hasAnyContent =
          (scrapeResult.menuText && scrapeResult.menuText.length >= 100) ||
          (scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0) ||
          (scrapeResult.menuImages && scrapeResult.menuImages.length > 0) ||
          !!scrapeResult.screenshotUrl;

        if (!hasAnyContent) {
          const msg =
            scrapeResult.warning ??
            "We opened the website but couldn't find a menu on it — some restaurants don't list their menu online. If you found a menu link we missed, paste that directly and we'll try again.";
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: msg });
          return close();
        }

        // Discover candidate menus
        send({ type: 'progress', step: 'Finding the menus...', stepNumber: 3, totalSteps: 4 });
        const discovery = await discoverMenus(scrapeResult);

        // The page had content but none of it is a menu (e.g. a booking-only
        // site, or only a drinks list): say so honestly instead of failing
        // later with a confusing "couldn't read the menu".
        if (discovery.candidates.length === 0) {
          const msg =
            "We couldn't find a food menu on this website — some restaurants don't publish one online. If they do, paste a direct link to their menu page and we'll try again.";
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: msg });
          return close();
        }
        attemptCategory = menuCategory(discovery.candidates);

        const ctx: ExtractContext = {
          title: discovery.restaurantTitle || scrapeResult.title,
          inlineText: discovery.inlineText,
          screenshotUrl: discovery.screenshotUrl,
          pdfUrls: scrapeResult.menuPdfUrls,
          imageUrls: scrapeResult.menuImages,
          pageUrl: discovery.finalUrl,
        };

        // Hand analysis to the resumable /analyze endpoint (serverless time
        // caps: extraction may span several short requests). Multiple distinct
        // menus → the user picks first; a single menu → seed the analysis
        // state ourselves and tell the client to proceed straight away.
        // If we can't persist state (e.g. the menu_candidates column hasn't
        // been migrated yet), degrade gracefully to analysing inline.
        try {
          await saveMenuCandidates(restaurantId, {
            candidates: discovery.candidates,
            finalUrl: discovery.finalUrl,
            title: ctx.title,
            inlineText: ctx.inlineText,
            screenshotUrl: ctx.screenshotUrl,
            pdfUrls: ctx.pdfUrls,
            imageUrls: ctx.imageUrls,
            ...(discovery.candidates.length === 1 && {
              analysis: { queue: discovery.candidates.map((c) => c.id), done: [], category: attemptCategory ?? undefined },
            }),
          });
          // Discovery succeeded — analysis continues in /analyze, which logs
          // its own terminal outcome (hence no analysis_completed here).
          await logAttempt(true);
          if (discovery.candidates.length >= 2) {
            send({ type: 'candidates', restaurantId, candidates: discovery.candidates });
          } else {
            send({ type: 'continue', restaurantId });
          }
          return close();
        } catch {
          // fall through to inline analysis of all discovered menus
        }

        // Candidates couldn't be persisted → analyze inline (may exceed the
        // serverless cap on heavy sites; this is a degraded path only).
        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 4, totalSteps: 4 });
        // Stream live extraction status so long analyses don't look frozen.
        ctx.onProgress = (message) => send({ type: 'progress', step: message, stepNumber: 4, totalSteps: 4 });
        let menu;
        let usage;
        try {
          const result = await extractAndMerge(discovery.candidates, ctx);
          menu = result.menu;
          usage = result.usage;
        } catch (err) {
          Sentry.captureException(err);
          const msg = err instanceof Error ? err.message : 'AI classification failed';
          // Failed retry ladders still spent tokens — record them.
          if (err instanceof ExtractionError && err.usage) {
            await logUsage(restaurantId, discovery.finalUrl, err.usage, ctx.title);
          }
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: msg });
          return close();
        }

        if (!menu.restaurantName && ctx.title) menu.restaurantName = ctx.title;

        await saveClassifiedMenu(restaurantId, discovery.finalUrl, scrapeResult.menuUrl, menu, usage);
        await logAttempt(true);
        await emitAnalysisCompleted(true, menu.sections.reduce((n, s) => n + s.dishes.length, 0));
        send({ type: 'result', restaurantId });
      } catch (err) {
        Sentry.captureException(err);
        const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
        await logAttempt(false, msg);
        await emitAnalysisCompleted(false);
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
