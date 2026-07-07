import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { extractMenuResumable, mergeMenus, sumUsage, ExtractContext } from '@/lib/menu-extract';
import { getMenuCandidates, saveMenuCandidates, saveClassifiedMenu, markRestaurantError, logUsage, logParseAttempt } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { menuCategory } from '@/lib/telemetry';
import { checkRateLimit, getClientIp, hashIp } from '@/lib/rate-limit';
import type { AnalysisState, ParseEvent } from '@/types';
import { verifyVegClassifications, type AIUsage } from '@/lib/ai';

// Fits the Vercel Hobby 60s cap: each request analyses within TIME_BUDGET_MS
// and, if unfinished, persists its progress and asks the client to call back
// (a 'continue' event). One long analysis = several short requests.
export const maxDuration = 60;
const TIME_BUDGET_MS = 40_000;
const NO_MENU_MSG =
  "We couldn't read a food menu on this website — it may not publish one online. If it does, paste a direct link to the menu page and we'll try again.";

const schema = z.object({
  restaurantId: z.string().uuid('Invalid restaurant id'),
  // Present on the first call (starts a fresh analysis, rate-limited);
  // absent on 'continue' callbacks (resumes stored state, not rate-limited).
  candidateIds: z.array(z.string()).min(1).optional(),
});

function sseEncoder() {
  const encoder = new TextEncoder();
  return (event: ParseEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const encode = sseEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ParseEvent) => {
        try {
          controller.enqueue(encode(event));
        } catch {}
      };
      const close = () => {
        try {
          controller.close();
        } catch {}
      };

      // Telemetry — logged at terminal outcomes only ('continue' hand-backs
      // are one analysis spread over several requests, not several attempts).
      const startedAt = Date.now();
      let attemptUrl: string | null = null;
      let attemptCategory: string | null = null;
      const logAttempt = (success: boolean, errorMessage?: string) => {
        if (!attemptUrl) return Promise.resolve();
        return logParseAttempt({
          url: attemptUrl,
          stage: 'analyze',
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
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          send({ type: 'error', error: 'Invalid request body' });
          return close();
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          send({ type: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return close();
        }
        const { restaurantId, candidateIds } = parsed.data;

        const payload = await getMenuCandidates(restaurantId).catch(() => null);
        if (!payload || !payload.candidates?.length) {
          send({ type: 'error', error: 'This selection expired — please search the restaurant again.' });
          return close();
        }

        // Resolve state: a fresh selection starts a new analysis (and counts
        // against the rate limit); a bare call resumes stored progress.
        let state: AnalysisState;
        if (candidateIds?.length) {
          const { allowed } = await checkRateLimit(ip);
          if (!allowed) {
            send({ type: 'error', error: `You've reached the limit of 5 searches per hour. Please try again later.` });
            return close();
          }
          // Resolve selected ids against the SERVER-STORED candidate list only.
          // No client-supplied URL is ever fetched (prevents SSRF).
          const selected = payload.candidates.filter((c) => candidateIds.includes(c.id));
          if (selected.length === 0) {
            send({ type: 'error', error: 'None of the selected menus could be found — please try again.' });
            return close();
          }
          state = { queue: selected.map((c) => c.id), done: [], category: menuCategory(selected) };
        } else if (payload.analysis) {
          state = payload.analysis;
        } else {
          send({ type: 'error', error: 'Nothing to resume — please search the restaurant again.' });
          return close();
        }
        attemptUrl = payload.finalUrl;
        attemptCategory = state.category ?? menuCategory(payload.candidates);

        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 1, totalSteps: 2 });

        const ctx: ExtractContext = {
          title: payload.title,
          inlineText: payload.inlineText,
          screenshotUrl: payload.screenshotUrl,
          pdfUrls: payload.pdfUrls,
          imageUrls: payload.imageUrls,
          pageUrl: payload.finalUrl,
          // Stream live extraction status so long analyses don't look frozen.
          onProgress: (message) => send({ type: 'progress', step: message, stepNumber: 1, totalSteps: 2 }),
        };

        const byId = new Map(payload.candidates.map((c) => [c.id, c]));
        const deadline = Date.now() + TIME_BUDGET_MS;

        try {
          while (state.currentId || state.queue.length > 0) {
            if (!state.currentId) {
              state.currentId = state.queue.shift()!;
              state.attemptIndex = 0;
              state.bestSoFar = null;
              state.candidateUsage = null;
            }
            const candidate = byId.get(state.currentId);
            if (!candidate) {
              state.currentId = null;
              continue;
            }

            const r = await extractMenuResumable(
              candidate,
              ctx,
              state.attemptIndex ?? 0,
              deadline,
              state.bestSoFar ?? null,
              state.candidateUsage ?? undefined
            );

            if (r.nextIndex !== null) {
              // Time budget reached mid-chain — persist and hand back to the client.
              state.attemptIndex = r.nextIndex;
              state.bestSoFar = r.best;
              state.candidateUsage = r.usage ?? null;
              payload.analysis = state;
              await saveMenuCandidates(restaurantId, payload);
              send({ type: 'progress', step: 'Still reading the menu — continuing...', stepNumber: 1, totalSteps: 2 });
              send({ type: 'continue', restaurantId });
              return close();
            }

            // Candidate finished.
            if (r.best && r.best.menu.sections.length > 0) {
              state.done.push({ label: candidate.label, menu: r.best.menu });
            }
            state.usage = sumUsage(state.usage ?? undefined, r.usage);
            state.currentId = null;
            state.attemptIndex = 0;
            state.bestSoFar = null;
            state.candidateUsage = null;
          }
        } catch (err) {
          Sentry.captureException(err);
          const msg = err instanceof Error ? err.message : 'AI classification failed';
          // Failed attempts still spent tokens — record them before erroring.
          if (state.usage) await logUsage(restaurantId, payload.finalUrl, state.usage, payload.title);
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: msg });
          return close();
        }

        if (state.done.length === 0) {
          // The full retry ladder ran and found nothing — that's the most
          // expensive failure mode, so its spend must land in the log.
          if (state.usage) await logUsage(restaurantId, payload.finalUrl, state.usage, payload.title);
          await markRestaurantError(restaurantId, NO_MENU_MSG);
          await logAttempt(false, NO_MENU_MSG);
          await emitAnalysisCompleted(false);
          send({ type: 'error', error: NO_MENU_MSG });
          return close();
        }

        const merged = mergeMenus(state.done);

        // Strong-model audit of the veg/vegan labels users filter by — the
        // guardrail that makes cheap Haiku extraction safe. Never throws.
        send({ type: 'progress', step: 'Double-checking the vegetarian and vegan labels...', stepNumber: 2, totalSteps: 2 });
        const verified = await verifyVegClassifications(merged, payload.title);
        const menu = verified.menu;
        state.usage = sumUsage(state.usage ?? undefined, verified.usage);
        if (!menu.restaurantName && payload.title) menu.restaurantName = payload.title;

        send({ type: 'progress', step: 'Saving your results...', stepNumber: 2, totalSteps: 2 });
        const usage: AIUsage = state.usage ?? { model: 'unknown', tokensIn: 0, tokensOut: 0, costUsd: 0 };
        await saveClassifiedMenu(restaurantId, payload.finalUrl, payload.finalUrl, menu, usage);
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
