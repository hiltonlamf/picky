/**
 * Seeds the Dublin city guide with featured restaurants.
 * Run with: npx ts-node scripts/seed-dublin.ts
 *
 * Prerequisites:
 * - .env.local must be configured with Supabase credentials
 * - Database schema must be applied (db/schema.sql)
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

const DUBLIN_RESTAURANTS: { name: string; url: string }[] = [
  { name: 'Assassination Custard', url: 'https://assassinationcustard.com' },
  { name: 'Chez Max', url: 'https://chezmax.ie' },
  { name: 'Chubbys', url: 'https://chubbys.ie' },
  { name: 'Dimmi by Dunne & Crescenzi', url: 'https://dunneandcrescenzi.com/dimmi' },
  { name: 'King Sitric Seafood Bar & Accommodation', url: 'https://kingsitric.ie' },
  { name: 'Forêt', url: 'https://foret.ie' },
  { name: 'La Vespa', url: 'https://lavespa.ie' },
  { name: 'Mermaid Monkstown', url: 'https://mermaidmonkstown.com' },
  { name: 'Osteria Lucio', url: 'https://osterialucio.ie' },
  { name: 'Vada', url: 'https://vadacafe.ie' },
];

async function main() {
  // Dynamically import to avoid ESM/CJS conflicts
  const { createClient } = await import('@supabase/supabase-js');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('🌱 Seeding Dublin restaurants...\n');

  for (let i = 0; i < DUBLIN_RESTAURANTS.length; i++) {
    const { name, url } = DUBLIN_RESTAURANTS[i];

    // Check if restaurant already exists by URL (case-insensitive)
    let restaurantId: string;
    const { data: existing } = await supabase
      .from('restaurants')
      .select('id')
      .ilike('url', url)
      .maybeSingle();

    if (existing?.id) {
      restaurantId = existing.id;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('restaurants')
        .insert({ name, url, city: 'dublin', status: 'pending' })
        .select('id')
        .single();

      if (insertError || !inserted) {
        console.error(`❌ Failed to insert ${name}:`, insertError?.message);
        continue;
      }
      restaurantId = inserted.id;
    }

    const restaurant = { id: restaurantId };

    // Add to featured restaurants (ignore conflict if already featured)
    const { error: featError } = await supabase
      .from('featured_restaurants')
      .upsert(
        { restaurant_id: restaurant.id, city: 'dublin', display_order: i },
        { onConflict: 'restaurant_id,city', ignoreDuplicates: false }
      );

    if (featError) {
      console.error(`❌ Failed to feature ${name}:`, featError.message);
    } else {
      console.log(`✅ ${name} — added (id: ${restaurant.id})`);
    }
  }

  console.log('\n✅ Done! Now run the parse script or use the Picky UI to analyse each menu.');
  console.log('   Each restaurant will be analysed on first visit via the UI.');
}

main().catch(console.error);
