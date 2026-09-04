import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { extractCandidatesResumable, mergeMenus, mergePartialMenus, selectSubstantialMenus, sumUsage, ExtractContext, BLOCKED_MENU_MESSAGE, DEFAULT_ESCALATION_BUDGET, MIN_FOOD_ITEMS } from '@/lib/menu-extract';
import { getMenuCandidates, saveMenuCandidates, saveClassifiedMenu, markRestaurantError, markRestaurantNoMenu, logParseAttempt } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { withSpendContext, updateSpendContext } from '@/lib/ai-spend';
import { menuCategory, ANON_ID_COOKIE, classifyError, domainOf } from '@/lib/telemetry';
import { checkRateLimit, getClientIp, hashIp, MAX_SEARCHES_PER_HOUR } from '@/lib/rate-limit';
import { checkDailySpend, AT_CAPACITY_MESSAGE } from '@/lib/spend-guard';
import type { AnalysisState, ClassifiedMenu, ParseEvent } from '@/types';
import { countFoodItems, verifyVegClassifications, VERIFY_VEG_ENABLED, type AIUsage } from '@/lib/ai';
import { withDeadline } from '@/lib/deadline';

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
      // Attribution is filled in once the request body is parsed — see
      // lib/ai-spend.ts. Spend is recorded either way; this decides whether the
      // rows name the restaurant that caused them.
      await withSpendContext({}, async () => {
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
      let analysisStartedAt = startedAt;
      let attemptUrl: string | null = null;
      let attemptCategory: string | null = null;
      let activeState: AnalysisState | null = null;
      const requestTimingMs: Record<string, number> = {};
      let timingsFlushed = false;
      const measure = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        const stepStartedAt = Date.now();
        try {
          return await fn();
        } finally {
          requestTimingMs[name] = (requestTimingMs[name] ?? 0) + Date.now() - stepStartedAt;
        }
      };
      const flushTimings = () => {
        if (!activeState || timingsFlushed) return;
        activeState.timingMs ??= {};
        for (const [name, durationMs] of Object.entries(requestTimingMs)) {
          activeState.timingMs[name] = (activeState.timingMs[name] ?? 0) + durationMs;
        }
        timingsFlushed = true;
      };
      const reportTiming = (outcome: string) => {
        flushTimings();
        if (!activeState || !attemptUrl) return;
        console.info('[pipeline-timing]', JSON.stringify({
          stage: 'analyze',
          outcome,
          domain: domainOf(attemptUrl),
          durationMs: Date.now() - analysisStartedAt,
          requestCount: activeState.requestCount ?? 1,
          stepsMs: activeState.timingMs ?? {},
        }));
      };
      // outcome/dishCount default from `success`, so existing two-argument
      // callers keep working; the analyse-success path passes them explicitly.
      const logAttempt = (
        success: boolean,
        errorMessage?: string,
        dishCount?: number,
        outcome?: 'menu' | 'no_menu' | 'error' | 'thin'
      ) => {
        if (!attemptUrl) return Promise.resolve();
        reportTiming(outcome ?? (success ? 'menu' : 'error'));
        return logParseAttempt({
          url: attemptUrl,
          stage: 'analyze',
          category: attemptCategory,
          success,
          errorMessage: errorMessage ?? null,
          // `analysisStartedAt` survives every continue hop. Previously this
          // stored only the final request (always <60s), hiding the 2–3 minute
          // waits this telemetry was meant to reveal.
          durationMs: Date.now() - analysisStartedAt,
          anonId: request.cookies.get(ANON_ID_COOKIE)?.value ?? null,
          dishCount: dishCount ?? null,
          errorCode: success ? null : classifyError(errorMessage),
          // A thin menu is its own outcome, not a success: 7+ dishes is the
          // bar a real menu clears, and lumping 3 dishes in with 40 hides the
          // failure users actually notice.
          // A discover-stage success has no dishes yet, so it gets NO outcome —
          // the real outcome is recorded on the analyze row that follows. Only
          // rows that actually know a dish count claim 'menu' or 'thin'.
          outcome:
            outcome ??
            (!success
              ? 'error'
              : dishCount === undefined || dishCount === null
                ? null
                : dishCount < 7
                  ? 'thin'
                  : 'menu'),
        });
      };
      const distinctId = request.cookies.get(ANON_ID_COOKIE)?.value ?? hashIp(ip);
      const emitAnalysisCompleted = (success: boolean, dishCount?: number, errorMessage?: string) =>
        captureServer(request, distinctId, 'analysis_completed', {
          success,
          category: attemptCategory,
          duration_ms: Date.now() - analysisStartedAt,
          dish_count: dishCount ?? 0,
          domain: attemptUrl ? domainOf(attemptUrl) : null,
          // success:false alone gave no clue why. The stable code is what the
          // dashboard groups and alerts on; the raw message is for debugging.
          failure_reason: success ? null : classifyError(errorMessage),
          error_message: success ? null : errorMessage ?? null,
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
        updateSpendContext({ restaurantId });

        const payload = await measure('candidate_load', () => getMenuCandidates(restaurantId).catch(() => null));
        if (!payload || !payload.candidates?.length) {
          send({ type: 'error', error: 'This selection expired — please search the restaurant again.' });
          return close();
        }

        // Resolve state: a fresh selection continues a new analysis; a bare
        // call resumes stored progress. The rate-limit slot was already consumed
        // at the discover stage for this restaurant, so here we only CHECK the
        // budget (consume: false) — no double-counting a single new-restaurant
        // flow, while still refusing to proceed if the budget is already spent.
        let state: AnalysisState;
        if (candidateIds?.length) {
          // Global daily ceiling. Checked here as well as in /discover because
          // this route is entered directly when the user picks menus from the
          // candidate screen, which is where the expensive extraction starts.
          const spend = await checkDailySpend();
          if (!spend.allowed) {
            await captureServer(request, distinctId, 'spend_cap_hit', {
              stage: 'analyze',
              spent_usd: spend.spentUsd,
              cap_usd: spend.capUsd,
            });
            send({ type: 'error', error: AT_CAPACITY_MESSAGE });
            return close();
          }

          const { allowed } = await checkRateLimit(ip, { consume: false });
          if (!allowed) {
            send({ type: 'error', error: `You've reached the limit of ${MAX_SEARCHES_PER_HOUR} new-restaurant searches per hour. Please try again later.` });
            return close();
          }
          // Resolve selected ids against the SERVER-STORED candidate list only.
          // No client-supplied URL is ever fetched (prevents SSRF).
          const selected = payload.candidates.filter((c) => candidateIds.includes(c.id));
          if (selected.length === 0) {
            send({ type: 'error', error: 'None of the selected menus could be found — please try again.' });
            return close();
          }
          state = {
            queue: selected.map((c) => c.id),
            done: [],
            category: menuCategory(selected),
            totalCandidates: selected.length,
          };
        } else if (payload.analysis) {
          state = payload.analysis;
        } else {
          send({ type: 'error', error: 'Nothing to resume — please search the restaurant again.' });
          return close();
        }
        activeState = state;
        state.startedAtMs ??= startedAt;
        analysisStartedAt = state.startedAtMs;
        state.requestCount = (state.requestCount ?? 0) + 1;

        // Migrate an in-flight payload written by the old one-candidate-at-a-time
        // route. No paid work is repeated: its checkpoint becomes the first
        // entry in the new per-candidate map.
        state.candidateStates ??= {};
        if (state.currentId) {
          state.candidateStates[state.currentId] = {
            attemptIndex: state.attemptIndex ?? 0,
            bestSoFar: state.bestSoFar ?? null,
            usage: state.candidateUsage ?? null,
            evidence: state.evidence ?? null,
          };
          state.queue = [state.currentId, ...state.queue.filter((id) => id !== state.currentId)];
          state.currentId = null;
          state.attemptIndex = 0;
          state.bestSoFar = null;
          state.candidateUsage = null;
          state.evidence = null;
        }
        state.totalCandidates ??= state.queue.length + state.done.length;
        attemptUrl = payload.finalUrl;
        updateSpendContext({ url: payload.finalUrl });
        attemptCategory = state.category ?? menuCategory(payload.candidates);

        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 1, totalSteps: 2 });

        const ctx: ExtractContext = {
          title: payload.title,
          inlineText: payload.inlineText,
          screenshotUrl: payload.screenshotUrl,
          pdfUrls: payload.pdfUrls,
          imageUrls: payload.imageUrls,
          pageUrl: payload.finalUrl,
          // A PDF that already has its own dedicated `pdf` candidate must never
          // also be re-read via a different candidate's fallback (e.g. a
          // `subpage` candidate that links to the exact same PDF) — that's a
          // second full-price AI call over an identical document, and it can
          // clobber the PDF candidate's own correct multi-menu labelling once
          // mergeMenus sees 2 "named" results instead of 1. See
          // ExtractContext.excludePdfUrls.
          excludePdfUrls: payload.candidates.filter((c) => c.type === 'pdf').map((c) => c.ref),
          // Stream live extraction status so long analyses don't look frozen.
          onProgress: (message) => send({ type: 'progress', step: message, stepNumber: 1, totalSteps: 2 }),
          // Shared across the candidates this request works through, so two
          // candidates never pay twice for the same fallback PDF/images/shot.
          sharedAttempts: new Map(),
          // Seeded from what earlier requests already spent — a fresh budget
          // per resumed request would let a slow site buy an escalation every
          // time the client called back.
          escalationBudget: {
            remaining: Math.max(0, DEFAULT_ESCALATION_BUDGET - (state.escalationsUsed ?? 0)),
          },
          anyCandidateValid: { value: state.done.length > 0 },
        };

        const deadline = Date.now() + TIME_BUDGET_MS;

        try {
          const byId = new Map(payload.candidates.map((candidate) => [candidate.id, candidate]));
          const pending = state.queue.map((id) => byId.get(id)).filter(Boolean) as typeof payload.candidates;
          let partialPublishing = false;
          const publishFirstMenu = async (
            available: Array<{ label: string; menu: ClassifiedMenu }>,
            usage?: AIUsage
          ) => {
            const remainingMenuCount = Math.max(0, (state.totalCandidates ?? available.length) - available.length);
            if (
              state.partialPublished ||
              partialPublishing ||
              remainingMenuCount === 0 ||
              available.length === 0
            ) return;

            const partialMenu = mergePartialMenus(available);
            if (countFoodItems(partialMenu) < MIN_FOOD_ITEMS) return;
            if (!partialMenu.restaurantName && payload.title) partialMenu.restaurantName = payload.title;

            partialPublishing = true;
            try {
              await measure('partial_persistence', () =>
                saveClassifiedMenu(
                  restaurantId,
                  payload.finalUrl,
                  payload.finalUrl,
                  partialMenu,
                  usage,
                  { status: 'processing' }
                )
              );
              state.partialPublished = true;
              send({ type: 'partial_result', restaurantId, remainingMenuCount });
            } catch (error) {
              // Progressive display is an optimization. A failed partial save
              // must not discard the extraction or prevent the final save.
              Sentry.captureException(error);
            } finally {
              partialPublishing = false;
            }
          };

          // A previous time-capped request may already have completed a menu
          // before it had enough time left to publish it.
          if (state.done.length > 0) {
            await publishFirstMenu(state.done, state.usage ?? undefined);
          }
          const results = await measure('extraction', () =>
            // withDeadline clamps every reader/fetch/model call to the request's
            // remaining budget. Each candidate retains its own checkpoint when
            // the batch cannot finish inside this request.
            withDeadline(deadline, () =>
              extractCandidatesResumable(
                pending,
                ctx,
                state.candidateStates!,
                deadline,
                async ({ candidate, result }) => {
                  if (result.nextIndex !== null || !result.best) return;
                  await publishFirstMenu(
                    [...state.done, { label: candidate.label, menu: result.best.menu }],
                    sumUsage(state.usage ?? undefined, result.usage)
                  );
                }
              )
            )
          );

          state.escalationsUsed =
            DEFAULT_ESCALATION_BUDGET - (ctx.escalationBudget?.remaining ?? DEFAULT_ESCALATION_BUDGET);

          const stillPending: string[] = [];
          for (const { candidate, result } of results) {
            if (result.nextIndex !== null) {
              stillPending.push(candidate.id);
              state.candidateStates[candidate.id] = {
                attemptIndex: result.nextIndex,
                bestSoFar: result.best,
                usage: result.usage ?? null,
                evidence: result.evidence ?? null,
              };
              continue;
            }
            delete state.candidateStates[candidate.id];
            if (result.best && result.best.menu.sections.length > 0) {
              state.done.push({ label: candidate.label, menu: result.best.menu });
            }
            if (result.blocked) state.blocked = true;
            state.usage = sumUsage(state.usage ?? undefined, result.usage);
          }
          state.queue = stillPending;

          if (state.queue.length > 0) {
            payload.analysis = state;
            await measure('checkpoint_save', () => saveMenuCandidates(restaurantId, payload));
            // Include persistence in this request's timing event. The aggregate
            // duration remains authoritative across hops; persisting this one
            // just-finished duration would itself require another DB write.
            flushTimings();
            console.info('[pipeline-timing]', JSON.stringify({
              stage: 'analyze',
              outcome: 'continue',
              domain: domainOf(payload.finalUrl),
              durationMs: Date.now() - analysisStartedAt,
              requestCount: state.requestCount,
              remainingCandidates: state.queue.length,
              stepsMs: state.timingMs ?? {},
            }));
            send({ type: 'progress', step: 'Still reading the menu — continuing...', stepNumber: 1, totalSteps: 2 });
            send({ type: 'continue', restaurantId });
            return close();
          }
        } catch (err) {
          Sentry.captureException(err);
          const msg = err instanceof Error ? err.message : 'AI classification failed';
          // Failed attempts still spent tokens — record them before erroring.
          // (spend already recorded by callClaude when the API call returned)
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          await Promise.all([logAttempt(false, msg), emitAnalysisCompleted(false, 0, msg)]);
          return close();
        }

        if (state.done.length === 0) {
          // The full retry ladder ran and found nothing — that's the most
          // expensive failure mode, so its spend must land in the log. This is
          // a "no readable menu" outcome (not a system error): store it as
          // no_menu so the results page shows the friendly, actionable screen
          // and future searches don't re-pay to re-read a menu-less site.
          // (spend already recorded by callClaude when the API call returned)
          // "We were refused" is not "there is no menu". Record it as its own
          // reason so the admin queue and the eval dashboard can tell the two
          // apart, and show the user copy that asks for a hand instead of
          // telling them the restaurant doesn't publish a menu.
          const blockedRun = state.blocked === true;
          const failureMsg = blockedRun ? BLOCKED_MENU_MESSAGE : NO_MENU_MSG;
          await markRestaurantNoMenu(restaurantId, blockedRun ? 'blocked' : 'not_listed', failureMsg);
          send({ type: 'no_menu', restaurantId });
          await Promise.all([
            logAttempt(false, failureMsg, undefined, 'no_menu'),
            emitAnalysisCompleted(false, 0, failureMsg),
          ]);
          return close();
        }

        const merged = mergeMenus(selectSubstantialMenus(state.done));

        // Strong-model audit of the veg/vegan labels. OFF by default since
        // 2026-08-08 (see VERIFY_VEG_ENABLED) — a no-op returning `merged`
        // unless VERIFY_VEG=1, so the progress step is gated too rather than
        // announcing work that isn't happening. Never throws. When enabled it
        // shares the extraction loop's `deadline`, not a fresh allowance.
        if (VERIFY_VEG_ENABLED) {
          send({ type: 'progress', step: 'Double-checking the vegetarian and vegan labels...', stepNumber: 2, totalSteps: 2 });
        }
        const verified = await measure('verification', () =>
          withDeadline(deadline, () => verifyVegClassifications(merged, payload.title))
        );
        const menu = verified.menu;
        state.usage = sumUsage(state.usage ?? undefined, verified.usage);
        if (!menu.restaurantName && payload.title) menu.restaurantName = payload.title;

        send({ type: 'progress', step: 'Saving your results...', stepNumber: 2, totalSteps: 2 });
        const usage: AIUsage = state.usage ?? { model: 'unknown', tokensIn: 0, tokensOut: 0, costUsd: 0 };
        await measure('persistence', () =>
          saveClassifiedMenu(restaurantId, payload.finalUrl, payload.finalUrl, menu, usage)
        );
        const dishCount = menu.sections.reduce((n, s) => n + s.dishes.length, 0);
        // The result is durable now. Let the browser navigate immediately while
        // best-effort operational/product telemetry flushes concurrently.
        send({ type: 'result', restaurantId });
        await Promise.all([
          logAttempt(true, undefined, dishCount),
          emitAnalysisCompleted(true, dishCount),
        ]);
      } catch (err) {
        Sentry.captureException(err);
        const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
        await logAttempt(false, msg);
        send({ type: 'error', error: msg });
        await emitAnalysisCompleted(false, 0, msg);
      }
      close();
      });
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
