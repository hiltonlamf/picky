/**
 * End-to-end test for PDF menu and blocked-site flows.
 * Run locally: ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-pdf-menus.ts
 */

import { scrapeRestaurant } from '../lib/scraper';
import { classifyMenuAgentic, countFoodItems } from '../lib/ai';

const URLS = [
  'https://www.wallacewinebars.ie/',
  'https://www.camdenkitchen.ie/',
];

async function testUrl(url: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`URL: ${url}`);
  console.log('─'.repeat(60));

  // ── Step 1: Scrape ───────────────────────────────────────────
  let scrapeResult: Awaited<ReturnType<typeof scrapeRestaurant>> | null = null;
  try {
    console.log('\n[1] Scraping...');
    scrapeResult = await scrapeRestaurant(url);
    console.log(`    urlType:     ${scrapeResult.urlType}`);
    console.log(`    canonicalUrl:${scrapeResult.canonicalUrl}`);
    console.log(`    menuUrl:     ${scrapeResult.menuUrl ?? '(none)'}`);
    console.log(`    text length: ${scrapeResult.menuText?.length ?? 0} chars`);
    console.log(`    PDFs found:  ${scrapeResult.menuPdfUrls?.length ?? 0} — ${JSON.stringify(scrapeResult.menuPdfUrls ?? [])}`);
    console.log(`    images:      ${scrapeResult.menuImages?.length ?? 0}`);
    if (scrapeResult.warning) console.log(`    ⚠ warning:   ${scrapeResult.warning}`);
  } catch (err) {
    console.log(`    ✗ Scraper threw: ${err instanceof Error ? err.message : err}`);
    console.log('    → Falling through to AI with empty content (web_search fallback)');
  }

  // ── Step 2: AI classification ────────────────────────────────
  console.log('\n[2] Classifying with AI...');
  try {
    const result = await classifyMenuAgentic(url, {
      text: scrapeResult?.menuText,
      pdfUrls: scrapeResult?.menuPdfUrls,
      imageUrls: scrapeResult?.menuImages,
      title: scrapeResult?.title,
    });

    const count = countFoodItems(result.menu);
    console.log(`    ✓ Dishes found: ${count}`);
    console.log(`    Restaurant:     ${result.menu.restaurantName ?? '(unknown)'}`);
    console.log(`    Sections:       ${result.menu.sections.map(s => `${s.name} (${s.dishes.length})`).join(', ')}`);
    console.log(`    Cost:           $${result.usage.costUsd.toFixed(4)}`);

    if (count > 0) {
      console.log('\n    Sample dishes:');
      for (const section of result.menu.sections.slice(0, 2)) {
        for (const dish of section.dishes.slice(0, 3)) {
          console.log(`      [${dish.classification.toUpperCase()}] ${dish.name}`);
        }
      }
      console.log(`\n    ✅ PASS — ${count} dishes classified`);
    } else {
      console.log('\n    ❌ FAIL — zero dishes returned');
    }
  } catch (err) {
    console.log(`    ✗ AI threw: ${err instanceof Error ? err.message : err}`);
    console.log('\n    ❌ FAIL');
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Run with:');
    console.error('  ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-pdf-menus.ts');
    process.exit(1);
  }

  console.log('Testing PDF menu flow end-to-end...');
  for (const url of URLS) {
    await testUrl(url);
  }
  console.log(`\n${'─'.repeat(60)}\nDone.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
