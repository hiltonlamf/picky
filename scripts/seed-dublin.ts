/**
 * Seeds the Dublin city guide with featured restaurants and fully parses each menu.
 * Run with: npx ts-node scripts/seed-dublin.ts
 *
 * Prerequisites:
 * - .env.local must be configured with Supabase + Anthropic credentials
 * - Database schema must be applied (db/schema.sql)
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local'), quiet: true });

const DUBLIN_RESTAURANTS: { name: string; url: string }[] = [
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

async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const { scrapeRestaurant } = await import('../lib/scraper');
  const { classifyMenuWithAI, classifyMenuFromImages, classifyMenuFromPdf, countFoodItems } = await import('../lib/ai');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('🌱 Seeding and parsing Dublin restaurants...\n');

  for (let i = 0; i < DUBLIN_RESTAURANTS.length; i++) {
    const { name, url } = DUBLIN_RESTAURANTS[i];
    console.log(`\n[${i + 1}/${DUBLIN_RESTAURANTS.length}] ${name} — ${url}`);

    // Upsert restaurant record
    let restaurantId: string;
    const { data: existing } = await supabase
      .from('restaurants')
      .select('id, status')
      .ilike('url', url)
      .maybeSingle();

    if (existing?.id) {
      restaurantId = existing.id;
      // Skip if already fully parsed
      if (existing.status === 'done') {
        console.log(`  ✅ Already parsed — skipping`);
        await supabase
          .from('featured_restaurants')
          .upsert({ restaurant_id: restaurantId, city: 'dublin', display_order: i }, { onConflict: 'restaurant_id,city' });
        continue;
      }
    } else {
      const { data: inserted, error } = await supabase
        .from('restaurants')
        .insert({ name, url, city: 'dublin', status: 'processing' })
        .select('id')
        .single();
      if (error || !inserted) {
        console.error(`  ❌ Failed to insert: ${error?.message}`);
        continue;
      }
      restaurantId = inserted.id;
    }

    // Mark as processing
    await supabase.from('restaurants').update({ status: 'processing', error_message: null }).eq('id', restaurantId);

    // Add to featured (idempotent)
    await supabase
      .from('featured_restaurants')
      .upsert({ restaurant_id: restaurantId, city: 'dublin', display_order: i }, { onConflict: 'restaurant_id,city' });

    // Scrape
    let scrapeResult;
    try {
      console.log(`  🔍 Scraping...`);
      scrapeResult = await scrapeRestaurant(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scrape failed';
      console.error(`  ❌ Scrape failed: ${msg}`);
      await supabase.from('restaurants').update({ status: 'error', error_message: msg }).eq('id', restaurantId);
      continue;
    }

    if (scrapeResult.warning && !scrapeResult.menuText && !scrapeResult.menuPdfUrls?.length && !scrapeResult.menuImages?.length) {
      console.error(`  ⚠️  ${scrapeResult.warning}`);
      await supabase.from('restaurants').update({ status: 'error', error_message: scrapeResult.warning }).eq('id', restaurantId);
      continue;
    }

    // Classify
    const MIN_FOOD_ITEMS = 7;
    let menu: Awaited<ReturnType<typeof classifyMenuWithAI>>['menu'] | null = null;
    let aiUsage: Awaited<ReturnType<typeof classifyMenuWithAI>>['usage'] | undefined;

    try {
      const hasText = scrapeResult.menuText && scrapeResult.menuText.length >= 100;
      const hasPdfs = scrapeResult.menuPdfUrls && scrapeResult.menuPdfUrls.length > 0;
      const hasImages = scrapeResult.menuImages && scrapeResult.menuImages.length > 0;

      if (hasPdfs && !hasText) {
        console.log(`  📄 Classifying via PDF...`);
        const pdfResult = await classifyMenuFromPdf(scrapeResult.menuPdfUrls![0], scrapeResult.title || name);
        if (pdfResult) { menu = pdfResult.menu; aiUsage = pdfResult.usage; }
      }

      if ((!menu || countFoodItems(menu) < MIN_FOOD_ITEMS) && !hasText && hasImages) {
        console.log(`  🖼️  Classifying via image vision...`);
        const imgResult = await classifyMenuFromImages(scrapeResult.menuImages!, scrapeResult.title || name);
        if (imgResult && (!menu || countFoodItems(imgResult.menu) > countFoodItems(menu!))) {
          menu = imgResult.menu; aiUsage = imgResult.usage;
        }
      }

      if (!menu || countFoodItems(menu) < MIN_FOOD_ITEMS) {
        if (hasText) {
          console.log(`  🤖 Classifying via text...`);
          const textResult = await classifyMenuWithAI(scrapeResult.menuText, scrapeResult.title || name);
          if (!menu || countFoodItems(textResult.menu) > countFoodItems(menu)) {
            menu = textResult.menu; aiUsage = textResult.usage;
          }
        }
      }

      if (!menu) throw new Error('All classification methods failed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Classification failed';
      console.error(`  ❌ AI failed: ${msg}`);
      await supabase.from('restaurants').update({ status: 'error', error_message: msg }).eq('id', restaurantId);
      continue;
    }

    if (!menu.restaurantName) menu.restaurantName = name;

    // Save — clear old dishes/sections first
    await supabase.from('dishes').delete().eq('restaurant_id', restaurantId);
    await supabase.from('menu_sections').delete().eq('restaurant_id', restaurantId);

    await supabase.from('restaurants').update({
      name: menu.restaurantName,
      canonical_url: scrapeResult.canonicalUrl,
      menu_url: scrapeResult.menuUrl ?? null,
      status: 'done',
      last_scraped_at: new Date().toISOString(),
      ...(aiUsage && {
        model_used: aiUsage.model,
        tokens_in: aiUsage.tokensIn,
        tokens_out: aiUsage.tokensOut,
        cost_usd: aiUsage.costUsd,
      }),
    }).eq('id', restaurantId);

    let totalDishes = 0;
    for (let si = 0; si < menu.sections.length; si++) {
      const section = menu.sections[si];
      const { data: sectionRow } = await supabase
        .from('menu_sections')
        .insert({ restaurant_id: restaurantId, name: section.name, display_order: si })
        .select('id')
        .single();
      if (!sectionRow) continue;

      const dishRows = section.dishes.map((d) => ({
        restaurant_id: restaurantId,
        section_id: sectionRow.id,
        name: d.name,
        description: d.description ?? null,
        price: d.price ?? null,
        classification: d.classification,
        confidence: d.confidence,
        confidence_reason: d.reason ?? null,
      }));

      if (dishRows.length > 0) {
        await supabase.from('dishes').insert(dishRows);
        totalDishes += dishRows.length;
      }
    }

    const cost = aiUsage ? `$${aiUsage.costUsd.toFixed(4)}` : 'n/a';
    console.log(`  ✅ Done — ${totalDishes} dishes saved (${aiUsage?.model ?? 'n/a'}, ${cost})`);
  }

  console.log('\n✅ Dublin seed complete. All restaurants parsed and saved.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
