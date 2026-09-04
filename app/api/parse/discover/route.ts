import { NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { scrapeRestaurant } from '@/lib/scraper';
import { discoverMenus } from '@/lib/menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext, sumUsage } from '@/lib/menu-extract';
import {
  findExistingRestaurant,
  resetRestaurantForReparse,
  createRestaurantRecord,
  saveRestaurantLocations,
  saveClassifiedMenu,
  saveMenuCandidates,
  markRestaurantError,
  markRestaurantNoMenu,
  logParseAttempt,
  getRestaurantSearchTarget,
  findRestaurantIdByProviderPlace,
  linkRestaurantProviderPlace,
} from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { withSpendContext, updateSpendContext } from '@/lib/ai-spend';
import { withDeadline } from '@/lib/deadline';
import { menuCategory, ANON_ID_COOKIE, classifyError, domainOf } from '@/lib/telemetry';
import {
  checkRateLimit,
  checkPlaceLookupRateLimit,
  getClientIp,
  hashIp,
  MAX_SEARCHES_PER_HOUR,
} from '@/lib/rate-limit';
import { checkDailySpend, AT_CAPACITY_MESSAGE } from '@/lib/spend-guard';
import { assertPublicUrl, BlockedUrlError } from '@/lib/url-guard';
import { STALENESS_DAYS } from '@/lib/dietary-config';
import { GooglePlacesError, resolveGoogleRestaurant } from '@/lib/google-places';
import { captureGooglePlacesFailure, trackGooglePlacesIssue } from '@/lib/google-places-observability';
import type { ParseEvent } from '@/types';

// Vercel Hobby caps functions at 60s. This route only scrapes + discovers
// (analysis is handed to the resumable /analyze endpoint), which fits.
export const maxDuration = 60;

const schema = z.union([
  z.object({ url: z.string().url('Please provide a valid URL') }),
  z.object({ restaurantId: z.string().uuid('Invalid restaurant') }),
  z.object({
    googlePlaceId: z.string().trim().min(1).max(256),
    sessionToken: z.string().trim().min(1).max(36),
  }),
]);

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
      // Opened empty and filled in below: discovery runs before the restaurant
      // row exists, so attribution can't be known here yet. Spend is recorded
      // either way — this only decides whether the rows say which restaurant.
      // Same cap as extraction: scraping a slow site plus a deep crawl can run
      // long, and without a deadline one read can consume the whole function.
      // 50s leaves headroom under the 60s limit to still send a clean event.
      await withDeadline(Date.now() + 50_000, () => withSpendContext({}, async () => {
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
      const timingMs: Record<string, number> = {};
      let timingLogged = false;
      const measure = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        const stepStartedAt = Date.now();
        try {
          return await fn();
        } finally {
          timingMs[name] = (timingMs[name] ?? 0) + Date.now() - stepStartedAt;
        }
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
        if (!timingLogged) {
          timingLogged = true;
          console.info('[pipeline-timing]', JSON.stringify({
            stage: 'discover',
            outcome: outcome ?? (success ? 'handoff' : 'error'),
            domain: domainOf(attemptUrl),
            durationMs: Date.now() - startedAt,
            stepsMs: timingMs,
          }));
        }
        return logParseAttempt({
          url: attemptUrl,
          stage: 'discover',
          category: attemptCategory,
          success,
          errorMessage: errorMessage ?? null,
          durationMs: Date.now() - startedAt,
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
          duration_ms: Date.now() - startedAt,
          dish_count: dishCount ?? 0,
          domain: attemptUrl ? domainOf(attemptUrl) : null,
          // success:false alone gave no clue why. The stable code is what the
          // dashboard groups and alerts on; the raw message is for debugging.
          failure_reason: success ? null : classifyError(errorMessage),
          error_message: success ? null : errorMessage ?? null,
        });

      try {
        let body: Record<string, unknown>;
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

        // SSRF gate at the door. The scraper and reader guard themselves too,
        // but rejecting here means the visitor gets one clean message instead
        // of a confusing failure several layers down. `z.string().url()` alone
        // accepts anything URL-parseable, including internal hosts.
        if ('url' in parsed.data) {
          try {
            await assertPublicUrl(parsed.data.url);
          } catch (err) {
            send({
              type: 'error',
              error:
                err instanceof BlockedUrlError
                  ? err.message
                  : 'That does not look like a valid web address.',
            });
            return close();
          }
        }
        let url: string;
        let discoveryCity = 'unassigned';
        let selectedGooglePlaceId: string | null = null;

        if ('restaurantId' in parsed.data) {
          const target = await getRestaurantSearchTarget(parsed.data.restaurantId);
          if (!target) {
            send({ type: 'error', error: 'That restaurant is no longer available. Search again.' });
            return close();
          }
          url = target.url;
          discoveryCity = target.city;
        } else if ('googlePlaceId' in parsed.data) {
          selectedGooglePlaceId = parsed.data.googlePlaceId;
          discoveryCity = 'dublin';

          // A previously selected Google branch is just another Platefully cache
          // lookup. Resolve its stored URL without another paid Places call.
          const linkedId = await findRestaurantIdByProviderPlace('google', selectedGooglePlaceId).catch(() => null);
          const linked = linkedId ? await getRestaurantSearchTarget(linkedId).catch(() => null) : null;
          if (linked) {
            url = linked.url;
          } else {
            const lookupBudget = await checkPlaceLookupRateLimit(ip, 'details');
            if (!lookupBudget.allowed) {
              await trackGooglePlacesIssue({
                request,
                distinctId,
                operation: 'details',
                reason: 'rate_limited',
              });
              send({ type: 'error', error: 'Too many restaurant lookups right now. Paste the website link or try again later.' });
              return close();
            }
            send({ type: 'progress', step: 'Finding the restaurant website...', stepNumber: 1, totalSteps: 5 });
            try {
              const place = await resolveGoogleRestaurant(
                selectedGooglePlaceId,
                parsed.data.sessionToken,
                request.signal
              );
              if (place.businessStatus === 'CLOSED_PERMANENTLY') {
                await trackGooglePlacesIssue({
                  request,
                  distinctId,
                  operation: 'details',
                  reason: 'closed_permanently',
                });
                send({ type: 'error', error: 'Google lists this restaurant as permanently closed. Try another result.' });
                return close();
              }
              url = place.websiteUrl ?? place.googleMapsUrl ?? '';
              if (!url) {
                await trackGooglePlacesIssue({
                  request,
                  distinctId,
                  operation: 'details',
                  reason: 'missing_website',
                });
                send({ type: 'error', error: "We couldn't find an official website for that restaurant. Paste a website or menu link instead." });
                return close();
              }
            } catch (error) {
              await captureGooglePlacesFailure({
                request,
                distinctId,
                error,
                operation: 'details',
              });
              const message = error instanceof GooglePlacesError
                ? error.userMessage
                : 'We could not look up that restaurant. Paste its website link or try again.';
              send({ type: 'error', error: message });
              return close();
            }
          }
        } else {
          url = parsed.data.url;
        }
        attemptUrl = url;
        updateSpendContext({ url });

        // Cache check FIRST. A restaurant that's already in our database and
        // fresh is served with ZERO LLM calls, so it must NOT count against the
        // rate limit — the limit exists only to cap the cost of NEW analyses.
        send({ type: 'progress', step: 'Checking our database...', stepNumber: 1, totalSteps: 4 });
        const existing = await measure('cache_lookup', () => findExistingRestaurant(url).catch(() => null));
        if (existing && selectedGooglePlaceId) {
          await linkRestaurantProviderPlace(existing.id, 'google', selectedGooglePlaceId);
        }
        if (existing?.status === 'done' && isFresh(existing.lastScrapedAt)) {
          send({ type: 'cached', restaurantId: existing.id });
          return close();
        }

        // Cached "no menu / dead site". Returning this costs ZERO AI, so like the
        // 'done' cache hit it must NOT re-run the paid pipeline or spend a rate
        // slot. We short-circuit when the outcome is durable:
        //   * admin-confirmed (any reason) — sticky forever, or
        //   * a fresh 'not_listed' — we DID read the site and it genuinely has no
        //     menu, so re-reading (a full paid extract) can't change the answer.
        // We deliberately DON'T cache an unconfirmed 'unavailable' (a fetch
        // failure): that may be a transient blip, and retrying a dead fetch is
        // cheap (no AI — the scrape throws before any model runs), so we let a
        // re-search retry it naturally until an admin confirms it's really dead.
        if (
          existing?.status === 'no_menu' &&
          (existing.noMenuConfirmedAt ||
            (existing.noMenuReason === 'not_listed' && isFresh(existing.lastScrapedAt)))
        ) {
          send({ type: 'no_menu', restaurantId: existing.id });
          return close();
        }

        // Past the cache: this WILL run the AI pipeline (a new restaurant, or a
        // stale reparse), so enforce and consume ONE rate-limit slot here — one
        // per new restaurant. The downstream /analyze step deliberately does not
        // consume another, so the whole flow costs the user a single slot.
        // Global daily ceiling, checked BEFORE the per-IP slot so a capped day
        // doesn't burn the visitor's hourly budget on a request we won't run.
        const spend = await checkDailySpend();
        if (!spend.allowed) {
          await captureServer(request, distinctId, 'spend_cap_hit', {
            stage: 'discover',
            spent_usd: spend.spentUsd,
            cap_usd: spend.capUsd,
          });
          send({ type: 'error', error: AT_CAPACITY_MESSAGE });
          return close();
        }

        const { allowed } = await checkRateLimit(ip);
        if (!allowed) {
          await captureServer(request, distinctId, 'rate_limit_hit', { stage: 'discover' });
          send({ type: 'error', error: `You've reached the limit of ${MAX_SEARCHES_PER_HOUR} new-restaurant searches per hour. Please try again later.` });
          return close();
        }

        let restaurantId = existing?.id ?? '';
        if (!restaurantId) {
          restaurantId = await measure('restaurant_record', () => createRestaurantRecord(url, discoveryCity));
          updateSpendContext({ restaurantId });
          if (selectedGooglePlaceId) {
            await linkRestaurantProviderPlace(restaurantId, 'google', selectedGooglePlaceId);
          }
        } else {
          await measure('restaurant_record', () => resetRestaurantForReparse(restaurantId));
        }

        // Scrape
        send({ type: 'progress', step: 'Fetching the restaurant page...', stepNumber: 2, totalSteps: 4 });
        let scrapeResult;
        let locationSave: Promise<void> = Promise.resolve();
        try {
          scrapeResult = await measure('scrape', () => scrapeRestaurant(url));
          // A best-effort side effect of the page fetch we already performed.
          // Location extraction is deterministic and adds no LLM/reader calls;
          // a location failure must never make menu analysis fail.
          const locations = scrapeResult.locations ?? (scrapeResult.location ? [scrapeResult.location] : []);
          if (locations.length) {
            // Persistence does not feed menu discovery, so overlap these DB
            // writes with the candidate-labeling work instead of serializing
            // them in front of it.
            locationSave = measure('location_save', () =>
              saveRestaurantLocations(restaurantId, locations).catch(() => undefined)
            );
          }
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : 'Could not fetch this page';
          // A fetch that never returned a page: treat as "site down / not live"
          // rather than a red error, so the user gets an honest, actionable
          // screen ("this site looks down — share the correct link"). Not cached
          // while unconfirmed (see the discover cache note), so a transient blip
          // retries naturally on the next search.
          const msg =
            "This website looks like it's down or not live yet. If that's not right, share a direct link to the menu and we'll read it.";
          await markRestaurantNoMenu(restaurantId, 'unavailable', rawMsg);
          await logAttempt(false, rawMsg, undefined, 'no_menu');
          await emitAnalysisCompleted(false, 0, rawMsg);
          send({ type: 'no_menu', restaurantId });
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
          await Promise.all([
            locationSave,
            markRestaurantNoMenu(restaurantId, 'not_listed', msg),
          ]);
          await logAttempt(false, msg, undefined, 'no_menu');
          await emitAnalysisCompleted(false, 0, msg);
          send({ type: 'no_menu', restaurantId });
          return close();
        }

        // Discover candidate menus
        send({ type: 'progress', step: 'Finding the menus...', stepNumber: 3, totalSteps: 4 });
        const discovery = await measure('menu_discovery', () => discoverMenus(scrapeResult));
        await locationSave;

        // The page had content but none of it is a menu (e.g. a booking-only
        // site, or only a drinks list): say so honestly instead of failing
        // later with a confusing "couldn't read the menu".
        if (discovery.candidates.length === 0) {
          const msg =
            "We couldn't find a food menu on this website — some restaurants don't publish one online. If they do, paste a direct link to their menu page and we'll try again.";
          await markRestaurantNoMenu(restaurantId, 'not_listed', msg);
          await logAttempt(false, msg, undefined, 'no_menu');
          await emitAnalysisCompleted(false, 0, msg);
          send({ type: 'no_menu', restaurantId });
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
          await measure('candidate_save', () => saveMenuCandidates(restaurantId, {
            candidates: discovery.candidates,
            finalUrl: discovery.finalUrl,
            title: ctx.title,
            inlineText: ctx.inlineText,
            screenshotUrl: ctx.screenshotUrl,
            pdfUrls: ctx.pdfUrls,
            imageUrls: ctx.imageUrls,
            ...(discovery.candidates.length === 1 && {
              analysis: {
                queue: discovery.candidates.map((c) => c.id),
                done: [],
                category: attemptCategory ?? undefined,
                totalCandidates: discovery.candidates.length,
              },
            }),
          }));
          // Discovery succeeded — analysis continues in /analyze, which logs
          // its own terminal outcome (hence no analysis_completed here, and no
          // outcome on this row: there are no dishes yet to judge).
          if (discovery.candidates.length >= 2) {
            send({ type: 'candidates', restaurantId, candidates: discovery.candidates });
          } else {
            send({ type: 'continue', restaurantId });
          }
          // Candidate state is durable; do not hold the next user-visible phase
          // behind a best-effort telemetry insert.
          await logAttempt(true);
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
            // (spend already recorded by callClaude when the API call returned)
          }
          // An ExtractionError means we found candidate menus but couldn't read
          // any dishes from them — that's "no readable menu", not a system error.
          if (err instanceof ExtractionError) {
            await markRestaurantNoMenu(restaurantId, 'not_listed', msg);
            await logAttempt(false, msg, undefined, 'no_menu');
            await emitAnalysisCompleted(false, 0, msg);
            send({ type: 'no_menu', restaurantId });
            return close();
          }
          await markRestaurantError(restaurantId, msg);
          await logAttempt(false, msg);
          await emitAnalysisCompleted(false, 0, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        if (!menu.restaurantName && ctx.title) menu.restaurantName = ctx.title;

        await saveClassifiedMenu(
          restaurantId,
          discovery.finalUrl,
          scrapeResult.menuUrl,
          menu,
          // Include discovery's billed labelling call, not just extraction.
          sumUsage(usage, discovery.usage)
        );
        await logAttempt(true, undefined, menu.sections.reduce((n, s) => n + s.dishes.length, 0));
        await emitAnalysisCompleted(true, menu.sections.reduce((n, s) => n + s.dishes.length, 0));
        send({ type: 'result', restaurantId });
      } catch (err) {
        Sentry.captureException(err);
        const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
        await logAttempt(false, msg);
        await emitAnalysisCompleted(false, 0, msg);
        send({ type: 'error', error: msg });
      }
      close();
      }));
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
