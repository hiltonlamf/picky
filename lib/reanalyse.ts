import * as Sentry from '@sentry/nextjs';
import { scrapeRestaurant } from './scraper';
import { discoverMenus } from './menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext, sumUsage } from './menu-extract';
import {
  getRestaurantMeta,
  resetRestaurantForReparse,
  saveClassifiedMenu,
  markRestaurantError,
  markRestaurantNoMenu,
  saveRestaurantLocations,
} from './db';

/**
 * Re-run the full pipeline for ONE restaurant already in the database.
 *
 * This is the single analysis path for admin-driven work, used by two callers
 * that must not diverge:
 *   - `POST /api/admin/restaurants/[id]/reparse` — one restaurant, on demand
 *   - `scripts/analyze-guide-queue.ts` — a whole city guide, on a GitHub runner
 *
 * It deliberately does NOT reuse `parseAndSave()` in ./init-dublin, and that
 * function should not be used for guide batches: it records every failure as
 * `error`, throwing away the distinction this one makes between a site that
 * genuinely has no menu (`not_listed`, sticky) and one whose menu we found but
 * could not read this time (`unavailable`, retryable). That difference decides
 * whether a restaurant is worth re-running, and getting it wrong publishes a
 * wrong verdict about a real restaurant.
 *
 * AI spend: every call still goes through `extractAndMerge` → `callClaude()`,
 * which records usage in `ai_usage_log` the moment the API returns. Nothing
 * here parses, returns early or throws before that happens, so moving this code
 * out of the route cannot lose a billed call.
 */

export type ReanalyseOutcome = 'done' | 'no_menu' | 'error';

export interface ReanalyseResult {
  outcome: ReanalyseOutcome;
  /** Dishes saved, on a successful run. */
  dishCount?: number;
  /** Spend for this restaurant, failed ladders included — never just successes. */
  costUsd?: number;
  /** User-facing explanation for a no_menu/error outcome. */
  message?: string;
  /** True when the restaurant id isn't in the database at all. */
  notFound?: boolean;
}

export async function reanalyseRestaurant(id: string): Promise<ReanalyseResult> {
  const restaurant = await getRestaurantMeta(id);
  if (!restaurant) return { outcome: 'error', notFound: true, message: 'Restaurant not found' };

  const url = restaurant.canonicalUrl ?? restaurant.url;
  // Marks the row `processing`, which is also the batch worker's lease: the
  // `updated_at` trigger stamps it, so another pass can tell a run that is
  // genuinely in flight from one that was abandoned (see ./guide-queue).
  await resetRestaurantForReparse(restaurant.id);

  let scrapeResult;
  try {
    scrapeResult = await scrapeRestaurant(url);
    const locations = scrapeResult.locations ?? (scrapeResult.location ? [scrapeResult.location] : []);
    if (locations.length) await saveRestaurantLocations(restaurant.id, locations).catch(() => undefined);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Could not fetch this page';
    await markRestaurantNoMenu(restaurant.id, 'unavailable', rawMsg);
    return { outcome: 'no_menu', message: rawMsg };
  }

  const hasAnyContent =
    (scrapeResult.menuText && scrapeResult.menuText.length >= 100) ||
    (scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0) ||
    (scrapeResult.menuImages && scrapeResult.menuImages.length > 0) ||
    !!scrapeResult.screenshotUrl;

  if (!hasAnyContent) {
    const msg = scrapeResult.warning ?? "We opened the website but couldn't find a menu on it.";
    await markRestaurantNoMenu(restaurant.id, 'not_listed', msg);
    return { outcome: 'no_menu', message: msg };
  }

  const discovery = await discoverMenus(scrapeResult);
  if (discovery.candidates.length === 0) {
    const msg = "We couldn't find a food menu on this website.";
    await markRestaurantNoMenu(restaurant.id, 'not_listed', msg);
    return { outcome: 'no_menu', message: msg };
  }

  const ctx: ExtractContext = {
    title: discovery.restaurantTitle || scrapeResult.title,
    inlineText: discovery.inlineText,
    screenshotUrl: discovery.screenshotUrl,
    pdfUrls: scrapeResult.menuPdfUrls,
    imageUrls: scrapeResult.menuImages,
    pageUrl: discovery.finalUrl,
  };

  let menu;
  let usage;
  try {
    // extractAndMerge already runs the strong-model veg/vegan audit
    // (verifyVegClassifications) internally before it returns — the same
    // guardrail the public flow applies. Do NOT re-audit the result below, or
    // every reparse pays for that expensive strong-model pass twice.
    const result = await extractAndMerge(discovery.candidates, ctx);
    menu = result.menu;
    usage = result.usage;
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'AI classification failed';
    if (err instanceof ExtractionError) {
      // Distinguish "we read the site and it genuinely has no menu" from "we
      // FOUND a menu (links/PDFs) but couldn't READ it this time". The latter is
      // almost always a transient read failure — most often the JS-rendering
      // reader being rate-limited on a batch — not a menuless restaurant. Recording
      // it as 'not_listed' (sticky "doesn't publish a menu") is a trust-breaking
      // wrong verdict AND blocks a retry; 'unavailable' stays retryable, so a
      // re-run (e.g. after a reader key is added) can succeed. If discovery found
      // no candidate at all, it really is "no menu here" → 'not_listed'.
      const foundMenuButUnread = discovery.candidates.length > 0;
      const reason = foundMenuButUnread ? 'unavailable' : 'not_listed';
      const userMsg = foundMenuButUnread
        ? "We found this restaurant's menu but couldn't read all of it this time — the site may have been slow to load. Try again."
        : msg;
      await markRestaurantNoMenu(restaurant.id, reason, userMsg);
      // Report the failed ladder's spend too (already recorded by callClaude when
      // each API call returned) — failures are the expensive path, so a batch's
      // running cost must count them, not just successes.
      return {
        outcome: 'no_menu',
        message: userMsg,
        costUsd: sumUsage(err.usage, discovery.usage).costUsd,
      };
    }
    await markRestaurantError(restaurant.id, msg);
    return { outcome: 'error', message: msg };
  }

  if (!menu.restaurantName && ctx.title) menu.restaurantName = ctx.title;

  // Discovery's labelling call is billed too — fold it in so the row we save
  // and the cost a batch sums both match ai_usage_log.
  const total = sumUsage(usage, discovery.usage);
  await saveClassifiedMenu(restaurant.id, discovery.finalUrl, scrapeResult.menuUrl, menu, total);

  const dishCount = menu.sections.reduce((n, s) => n + s.dishes.length, 0);
  return { outcome: 'done', dishCount, costUsd: total.costUsd };
}
