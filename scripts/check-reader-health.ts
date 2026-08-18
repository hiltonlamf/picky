// Is the page reader actually working? Run this BEFORE any batch analysis.
//
// FREE: one reader request, no AI calls, no DB writes.
//
//   npx tsx scripts/check-reader-health.ts
//
// Why this exists: on 2026-08-18 both reader accounts were out of credit at
// once (Jina and Firecrawl, HTTP 402). The pipeline degrades silently by
// design — it falls back to raw HTML and reports "no menu listed on this
// site" — so a batch run against a dead reader burns real AI money producing
// wrong results, and looks like a pipeline bug rather than a lapsed account.
// The outage IS reported to Sentry (reportReaderOutage in lib/reader.ts), but
// that only helps someone who happens to be watching Sentry at the time.
//
// Exits 1 when no provider can render a page, so it can gate a batch run.
import './_preload-env';
import { readPage, isReaderEnabled, jinaStatus, firecrawlStatus } from '@/lib/reader';

// A small, reliably JS-rendered page. Probing a static page would let this
// check pass while the reader was dead.
const PROBE_URL = 'https://www.featherblade.ie/steaks';

async function main() {
  console.log(`Reader health check — probing ${PROBE_URL}\n`);

  const key = (name: string) => (process.env[name] ? 'set' : 'MISSING');
  console.log(`  READER_PROVIDER   ${process.env.READER_PROVIDER ?? '(unset — Jina first, Firecrawl fallback)'}`);
  console.log(`  JINA_API_KEY      ${key('JINA_API_KEY')}`);
  console.log(`  FIRECRAWL_API_KEY ${key('FIRECRAWL_API_KEY')}`);

  if (!isReaderEnabled()) {
    console.log('\n✗ Reader is disabled entirely (no keys, or READER_PROVIDER=off).');
    console.log('  JS-rendered sites will look like they have no menu.');
    process.exit(1);
  }

  const result = await readPage(PROBE_URL);

  console.log(`\n  Jina       ${jinaStatus() ?? 'ok'}`);
  console.log(`  Firecrawl  ${firecrawlStatus() ?? 'ok'}`);

  if (!result || !result.markdown) {
    console.log('\n✗ NO PROVIDER COULD RENDER THE PAGE.');
    console.log('  Do NOT run a batch analysis: it will spend AI money and return');
    console.log('  "no menu listed on this site" for restaurants that plainly have one.');
    console.log('  A 402 above means the account is out of credit, not that the key is wrong.');
    process.exit(1);
  }

  console.log(
    `\n✓ Reader is working — ${result.markdown.length} chars, ` +
      `${result.links.length} links, ${result.imageUrls.length} images.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
