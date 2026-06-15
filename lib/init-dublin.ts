/**
 * Idempotent initialiser for the Dublin city guide.
 * Called on server start (instrumentation.ts) and by the seed script.
 * Only parses restaurants whose status is 'pending' or 'error'.
 */

import { scrapeRestaurant } from './scraper';
import { classifyMenuWithAI, classifyMenuFromImages, classifyMenuFromPdf, countFoodItems } from './ai';
import {
  createRestaurantRecord,
  saveClassifiedMenu,
  markRestaurantError,
  resetRestaurantForReparse,
} from './db';
import { createClient } from '@supabase/supabase-js';

const MIN_FOOD_ITEMS = 7;

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

  if (scrapeResult.warning && !scrapeResult.menuText && !scrapeResult.menuPdfUrls?.length && !scrapeResult.menuImages?.length) {
    await markRestaurantError(restaurantId, scrapeResult.warning);
    return;
  }

  const hasText = scrapeResult.menuText && scrapeResult.menuText.length >= 100;
  const hasPdfs = scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0;
  const hasImages = scrapeResult.menuImages && scrapeResult.menuImages.length > 0;

  let menu: Awaited<ReturnType<typeof classifyMenuWithAI>>['menu'] | null = null;
  let aiUsage: Awaited<ReturnType<typeof classifyMenuWithAI>>['usage'] | undefined;

  try {
    if (hasPdfs && !hasText) {
      const r = await classifyMenuFromPdf(scrapeResult.menuPdfUrls![0], name);
      if (r) { menu = r.menu; aiUsage = r.usage; }
    }

    if ((!menu || countFoodItems(menu) < MIN_FOOD_ITEMS) && !hasText && hasImages) {
      const r = await classifyMenuFromImages(scrapeResult.menuImages!, name);
      if (r && (!menu || countFoodItems(r.menu) > countFoodItems(menu!))) {
        menu = r.menu; aiUsage = r.usage;
      }
    }

    if (!menu || countFoodItems(menu) < MIN_FOOD_ITEMS) {
      if (hasText) {
        const r = await classifyMenuWithAI(scrapeResult.menuText, name);
        if (!menu || countFoodItems(r.menu) > countFoodItems(menu)) {
          menu = r.menu; aiUsage = r.usage;
        }
      }
    }
  } catch (err) {
    await markRestaurantError(restaurantId, err instanceof Error ? err.message : 'AI failed');
    return;
  }

  if (!menu) {
    await markRestaurantError(restaurantId, 'No menu content could be extracted');
    return;
  }

  if (!menu.restaurantName) menu.restaurantName = name;

  await saveClassifiedMenu(restaurantId, scrapeResult.canonicalUrl, scrapeResult.menuUrl ?? null, menu, aiUsage);
}

export async function initDublinRestaurants(): Promise<void> {
  const supabase = db();

  // Replace the featured list with exactly these 10 restaurants.
  // Deleting first ensures stale entries from previous seed runs don't linger.
  await supabase.from('featured_restaurants').delete().eq('city', 'dublin');

  // Pass 1 — insert all restaurant records and feature them immediately so the
  // Dublin page can render all 10 cards (pending ones show "Analysing…") before
  // any parsing has completed.
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

    await upsertFeatured(restaurantId, i);

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
