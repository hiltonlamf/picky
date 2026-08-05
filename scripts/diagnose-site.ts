/**
 * FREE scrape/discover diagnosis — no AI calls, no DB writes, no spend.
 *
 *   npx tsx scripts/diagnose-site.ts https://example.com [more urls...]
 *   npx tsx scripts/diagnose-site.ts --cases           # every pipeline case
 *   npx tsx scripts/diagnose-site.ts --cases newking   # filter by name/url
 *
 * Answers "what does the scraper actually SEE on this site?" before anyone
 * spends money guessing: HTTP reachability, which reader provider answered,
 * the declared language and any English variant, how much text came back and
 * whether it reads like a menu, plus every menu link / PDF / image / nav link
 * found and the candidates discovery would hand to extraction.
 *
 * Guaranteed free: the only paid step in discovery is the Haiku candidate
 * labeler, and this script blanks ANTHROPIC_API_KEY below so that call fails
 * fast. `discoverMenus` already degrades to "keep every candidate, label it
 * from its hint" when the labeler throws, so the real de-dupe/filter logic
 * still runs — only the cosmetic labels differ. `CLAUDE.md`: debug the free
 * scrape/discover stages first.
 */
import './_preload-env'; // MUST be first — loads env before lib modules evaluate

import { readFileSync } from 'fs';
import path from 'path';

// Belt and braces: no key, no spend. Set before any lib module is imported, so
// the lazily-constructed Anthropic client can never pick a real key back up.
process.env.ANTHROPIC_API_KEY = '';

import { scrapeRestaurant } from '../lib/scraper';
import { discoverMenus, textLooksLikeMenu } from '../lib/menu-discovery';
import { isReaderEnabled, readPage, jinaStatus, firecrawlStatus } from '../lib/reader';

interface Case {
  name: string;
  url: string;
}

/** Comma-separated substrings, so one run can target a specific set of sites
 *  ("tofu,lina,kas") rather than the whole suite — the keyless reader tier is
 *  rate-limited, so diagnosing 34 sites to look at 6 is self-defeating. */
export function selectCases(all: Case[], filter?: string): Case[] {
  const terms = (filter ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return all;
  return all.filter((c) =>
    terms.some((t) => c.name.toLowerCase().includes(t) || c.url.toLowerCase().includes(t))
  );
}

function casesFromJson(filter?: string): Case[] {
  const file = path.join(__dirname, '..', 'tests', 'pipeline-cases.json');
  const all = (JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
  return selectCases(all, filter);
}

function list(label: string, items: string[] | undefined, limit = 8): void {
  const arr = items ?? [];
  console.log(`  ${label} (${arr.length})`);
  for (const item of arr.slice(0, limit)) console.log(`      - ${item}`);
  if (arr.length > limit) console.log(`      … ${arr.length - limit} more`);
}

/** Raw reachability of the URL itself, independent of the scraper's fallbacks. */
async function probe(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const ct = res.headers.get('content-type') ?? 'unknown';
    const body = await res.text().catch(() => '');
    const lang = /<html[^>]*\blang=["']([^"']+)["']/i.exec(body)?.[1] ?? '(none)';
    // %PDF matters when probing a menu PDF directly: it separates "the host
    // served us the file" from "the host served us a page about the file".
    const isPdf = body.startsWith('%PDF') ? ' | REAL PDF' : '';
    return `HTTP ${res.status} ${res.ok ? '' : '(NOT OK — error page may be parsed as content)'} | ${ct} | ${body.length} bytes${isPdf} | <html lang="${lang}"> | final: ${res.url}`;
  } catch (err) {
    return `FETCH FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Raw probe of the Jina endpoint. `readWithJina` swallows every error and
 * returns null, so a dead reader and a merely-unhelpful one look identical to
 * callers — and a dead reader silently turns every JS-rendered restaurant into
 * "no menu listed on this site". This prints the actual HTTP status.
 */
async function probeJinaRaw(url: string): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'X-Return-Format': 'markdown',
    Accept: 'application/json',
  };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(25000) });
    const body = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
    // Name the status so the cause is unmistakable in a CI log: an unfunded
    // key and a missing key look identical from the outside otherwise.
    const meaning =
      res.status === 402
        ? ' ← ACCOUNT OUT OF CREDIT (top up or rely on Firecrawl)'
        : res.status === 401
          ? ' ← KEY INVALID'
          : res.status === 403
            ? ' ← FORBIDDEN (keyless requests get a Cloudflare challenge)'
            : res.status === 429
              ? ' ← RATE LIMITED'
              : '';
    return `HTTP ${res.status}${meaning} | key: ${process.env.JINA_API_KEY ? 'set' : 'NONE'} | body: ${body}`;
  } catch (err) {
    return `THREW: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Which reader provider answered, and with how much — the rate-limit tell. */
async function probeReader(url: string): Promise<string> {
  if (!isReaderEnabled()) return 'reader disabled (READER_PROVIDER=off)';
  const started = Date.now();
  const res = await readPage(url).catch(() => null);
  const ms = Date.now() - started;
  if (!res) {
    // Name the reason rather than leaving a bare "NO CONTENT": a sub-second
    // failure is an API rejecting us (quota/auth), not a page that wouldn't render.
    const why = [
      jinaStatus() ? `jina ${jinaStatus()}` : null,
      firecrawlStatus() ? `firecrawl ${firecrawlStatus()}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    return `NO CONTENT after ${ms}ms${why ? ` — ${why}` : ' — both providers returned nothing'} (this alone can cause "no menu")`;
  }
  return `${res.provider} | ${res.markdown.length} chars | ${res.links.length} links | ${res.pdfLinks.length} pdfs | screenshot: ${res.screenshotUrl ? 'yes' : 'no'} | ${ms}ms`;
}

async function diagnose(c: Case): Promise<boolean> {
  console.log(`\n${'='.repeat(78)}\n=== ${c.name} — ${c.url}\n${'='.repeat(78)}`);
  console.log(`  direct fetch: ${await probe(c.url)}`);
  console.log(`  reader:       ${await probeReader(c.url)}`);
  console.log(`  jina raw:     ${await probeJinaRaw(c.url)}`);

  let scrape;
  try {
    scrape = await scrapeRestaurant(c.url);
  } catch (err) {
    console.error(`  ✗ SCRAPE THREW: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const text = scrape.menuText ?? '';
  console.log(`  title:        ${scrape.title}`);
  console.log(`  canonicalUrl: ${scrape.canonicalUrl}`);
  console.log(`  urlType:      ${scrape.urlType}${scrape.warning ? ` | warning: ${scrape.warning}` : ''}`);
  console.log(`  text:         ${text.length} chars | looksLikeMenu: ${textLooksLikeMenu(text)}`);
  console.log(`  text sample:  ${JSON.stringify(text.slice(0, 240))}`);
  list('menuPdfUrls', scrape.menuPdfUrls);
  list('menuLinks', scrape.menuLinks);
  list('menuImages', scrape.menuImages);
  list('navLinks', scrape.navLinks);

  const discovery = await discoverMenus(scrape);
  console.log(`  CANDIDATES (${discovery.candidates.length}):`);
  for (const cand of discovery.candidates) {
    console.log(`      [${cand.type}] ${cand.label} — ${cand.ref || '(inline text)'}`);
  }

  // The user-visible failure this whole exercise is about.
  const wouldSayNoMenu = discovery.candidates.length === 0;
  console.log(`  VERDICT:      ${wouldSayNoMenu ? '✗ "No menu listed on this site"' : '✓ has candidates to extract'}`);
  return !wouldSayNoMenu;
}

async function main() {
  const args = process.argv.slice(2);
  const cases: Case[] =
    args[0] === '--cases'
      ? casesFromJson(args[1])
      : args.map((url) => ({ name: new URL(url.startsWith('http') ? url : `https://${url}`).hostname, url }));

  if (cases.length === 0) {
    console.error('Usage: npx tsx scripts/diagnose-site.ts <url...> | --cases [filter]');
    process.exit(1);
  }

  console.log(`Reader enabled: ${isReaderEnabled()} | diagnosing ${cases.length} site(s) — NO AI calls, NO DB writes`);

  const results: Array<{ name: string; ok: boolean }> = [];
  for (const c of cases) {
    // Sequential — the keyless reader tier is rate-limited, and hammering it
    // would produce exactly the false "no menu" signal we're investigating.
    results.push({ name: c.name, ok: await diagnose(c) });
  }

  // Header format matches run-pipeline-tests.ts so the workflow's summary
  // extraction (sed '/=* SUMMARY =*/,$p') picks this up unchanged.
  console.log('\n================ SUMMARY ================');
  console.log('  (discovery stage only — says nothing about dish counts)');
  // Provider health belongs in the summary: if a reader died partway through,
  // every site after it is a false negative and the per-site results below are
  // not evidence about the code.
  if (jinaStatus()) console.log(`  ⚠ jina disabled mid-run: ${jinaStatus()}`);
  if (firecrawlStatus()) console.log(`  ⚠ FIRECRAWL disabled mid-run: ${firecrawlStatus()}`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${results.length - failed}/${results.length} produced menu candidates`);
  // Diagnosis is information, not a gate — always exit 0 so a CI run showing
  // real failures still uploads its log.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
