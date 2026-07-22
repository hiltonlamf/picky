import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { scrapeRestaurant } from '@/lib/scraper';
import { discoverMenus } from '@/lib/menu-discovery';
import { extractAndMerge, ExtractionError, ExtractContext } from '@/lib/menu-extract';
import {
  getRestaurantMeta,
  resetRestaurantForReparse,
  saveClassifiedMenu,
  markRestaurantError,
  markRestaurantNoMenu,
  logUsage,
} from '@/lib/db';

// Admin-triggered re-run of the full pipeline for one restaurant already in
// the database (e.g. after a prompt/extraction fix, to pick up the new
// behaviour without waiting for the public flow's staleness window). Unlike
// the public /api/parse/discover + /analyze pair, this is a single blocking
// request — no per-IP rate limit (admin-only, gated by middleware.ts) and no
// resumable multi-request chain, since that machinery exists only to fit the
// public flow's serverless time cap on heavy sites. Same 60s Vercel Hobby cap
// still applies; this accepts the same overrun risk the public discover
// route's degraded inline-analysis fallback already accepts.
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const restaurant = await getRestaurantMeta(params.id);
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });

  const url = restaurant.canonicalUrl ?? restaurant.url;
  await resetRestaurantForReparse(restaurant.id);

  let scrapeResult;
  try {
    scrapeResult = await scrapeRestaurant(url);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Could not fetch this page';
    await markRestaurantNoMenu(restaurant.id, 'unavailable', rawMsg);
    return NextResponse.json({ outcome: 'no_menu', message: rawMsg });
  }

  const hasAnyContent =
    (scrapeResult.menuText && scrapeResult.menuText.length >= 100) ||
    (scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0) ||
    (scrapeResult.menuImages && scrapeResult.menuImages.length > 0) ||
    !!scrapeResult.screenshotUrl;

  if (!hasAnyContent) {
    const msg = scrapeResult.warning ?? "We opened the website but couldn't find a menu on it.";
    await markRestaurantNoMenu(restaurant.id, 'not_listed', msg);
    return NextResponse.json({ outcome: 'no_menu', message: msg });
  }

  const discovery = await discoverMenus(scrapeResult);
  if (discovery.candidates.length === 0) {
    const msg = "We couldn't find a food menu on this website.";
    await markRestaurantNoMenu(restaurant.id, 'not_listed', msg);
    return NextResponse.json({ outcome: 'no_menu', message: msg });
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
    if (err instanceof ExtractionError && err.usage) {
      await logUsage(restaurant.id, discovery.finalUrl, err.usage, ctx.title);
    }
    if (err instanceof ExtractionError) {
      await markRestaurantNoMenu(restaurant.id, 'not_listed', msg);
      return NextResponse.json({ outcome: 'no_menu', message: msg });
    }
    await markRestaurantError(restaurant.id, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!menu.restaurantName && ctx.title) menu.restaurantName = ctx.title;

  await saveClassifiedMenu(restaurant.id, discovery.finalUrl, scrapeResult.menuUrl, menu, usage);

  const dishCount = menu.sections.reduce((n, s) => n + s.dishes.length, 0);
  return NextResponse.json({ outcome: 'done', dishCount, costUsd: usage.costUsd });
}
