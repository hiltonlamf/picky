/**
 * Idempotent initialiser for the Dublin city guide.
 * Called on server start (instrumentation.ts) and by the seed script.
 * Only parses restaurants whose status is 'pending' or 'error'.
 */

import { scrapeRestaurant } from './scraper';
import { discoverMenus } from './menu-discovery';
import { extractAndMerge, ExtractContext } from './menu-extract';
import {
  createRestaurantRecord,
  saveClassifiedMenu,
  markRestaurantError,
  resetRestaurantForReparse,
} from './db';
import { createClient } from '@supabase/supabase-js';

export const DUBLIN_RESTAURANTS: { name: string; url: string }[] = [
  { name: 'Chapter One', url: 'https://chapteronerestaurant.com' },
  { name: 'Restaurant Patrick Guilbaud', url: 'https://restaurantpatrickguilbaud.ie' },
  { name: 'Delahunt', url: 'https://delahunt.ie' },
  { name: 'Uno Mas', url: 'https://unomas.ie' },
  { name: 'Bastible', url: 'https://bastible.com' },
  { name: 'Etto', url: 'https://etto.ie' },
  { name: 'Variety Jones', url: 'https://varietyjones.ie' },
  { name: 'Pickle', url: 'https://picklerestaurant.com' },
  { name: 'Bigfan', url: 'https://bigfan.ie' },
  { name: 'Achara', url: 'https://acharadublin.com' },
];

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key);
}

async function upsertFeatured(restaurantId: string, order: number) {
  await db()
    .from('featured_restaurants')
    .upsert(
      { restaurant_id: restaurantId, city: 'dublin', display_order: order },
      { onConflict: 'restaurant_id,city' }
    );
}

async function parseAndSave(restaurantId: string, name: string, url: string): Promise<void> {
  await resetRestaurantForReparse(restaurantId);

  let scrapeResult;
  try {
    scrapeResult = await scrapeRestaurant(url);
  } catch (err) {
    await markRestaurantError(restaurantId, err instanceof Error ? err.message : 'Scrape failed');
    return;
  }

  if (scrapeResult.warning && !scrapeResult.menuText && !scrapeResult.menuPdfUrls?.length && !scrapeResult.menuImages?.length && !scrapeResult.screenshotUrl) {
    await markRestaurantError(restaurantId, scrapeResult.warning);
    return;
  }

  let menu;
  let aiUsage;
  try {
    // Seeding analyses ALL discovered menus combined (no interactive picker).
    const discovery = await discoverMenus(scrapeResult);
    const ctx: ExtractContext = {
      title: name,
      inlineText: discovery.inlineText,
      screenshotUrl: discovery.screenshotUrl,
      pdfUrls: scrapeResult.menuPdfUrls,
      imageUrls: scrapeResult.menuImages,
      pageUrl: discovery.finalUrl,
    };
    const result = await extractAndMerge(discovery.candidates, ctx);
    menu = result.menu;
    aiUsage = result.usage;
  } catch (err) {
    await markRestaurantError(restaurantId, err instanceof Error ? err.message : 'No menu content could be extracted');
    return;
  }

  if (!menu.restaurantName) menu.restaurantName = name;

  await saveClassifiedMenu(restaurantId, scrapeResult.canonicalUrl, scrapeResult.menuUrl ?? null, menu, aiUsage);
}

export async function initDublinRestaurants(): Promise<void> {
  const supabase = db();

  // Guide membership is ADMIN-OWNED and persistent (curated from
  // /admin/restaurants). This seeder therefore only *bootstraps* the guide the
  // first time — if the Dublin guide already has any entries, we leave it
  // completely alone so an admin's add/remove is never wiped on a server
  // restart. (It used to delete-and-reseed on every boot, which fought with
  // admin curation.) The seeder still ensures the seed restaurants exist and
  // get parsed regardless.
  const { count: guideCount } = await supabase
    .from('featured_restaurants')
    .select('*', { count: 'exact', head: true })
    .eq('city', 'dublin');
  const bootstrapGuide = (guideCount ?? 0) === 0;

  const toparse: { id: string; name: string; url: string }[] = [];

  for (let i = 0; i < DUBLIN_RESTAURANTS.length; i++) {
    const { name, url } = DUBLIN_RESTAURANTS[i];

    const { data: existing } = await supabase
      .from('restaurants')
      .select('id, status')
      .ilike('url', url)
      .maybeSingle();

    let restaurantId: string;

    if (existing?.id) {
      restaurantId = existing.id;
    } else {
      try {
        restaurantId = await createRestaurantRecord(url);
        await supabase.from('restaurants').update({ name }).eq('id', restaurantId);
      } catch {
        continue;
      }
    }

    // Only feature on a first-time bootstrap (empty guide); never override admin curation afterwards.
    if (bootstrapGuide) await upsertFeatured(restaurantId, i);

    if (!existing || existing.status !== 'done') {
      toparse.push({ id: restaurantId, name, url });
    }
  }

  // Pass 2 — parse each restaurant that needs it (sequentially to avoid
  // hammering the AI API with 10 concurrent requests).
  for (const { id, name, url } of toparse) {
    await parseAndSave(id, name, url);
  }
}
