// Verify the city-guide index against live data.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping — it re-reads what
// is already in the database. Run it as often as you like.
//
//   npx tsx scripts/verify-guide-index.ts
//
// What it proves, and why it exists:
//
//   1. Every guide, its status, and the number of restaurants it shows — so you
//      can see at a glance whether Cork and Limerick are drafts or live.
//   2. That the restaurant count on /guides EXACTLY equals what the guide page
//      itself renders, guide by guide. These are two code paths reaching the
//      same number: /guides batches the bare minimum in five queries, while the
//      guide page loads whole restaurants and filters them. If they ever
//      disagree, /guides advertises a figure the page then contradicts — the
//      same class of bug as a restaurant showing two different veggie counts.
//      Unit tests cover the logic; only this can check the QUERIES.
//   3. That no guide sits on a slug another route would swallow.
//
// Exits non-zero on any mismatch, so it can gate a deploy.
import './_preload-env';
import { getPublishedCityGuides, getFeaturedRestaurants } from '@/lib/db';
import { isPubliclyVisible } from '@/lib/review-flags';
import { isReservedGuideSlug } from '@/lib/city-guides';

async function main() {
  // includeDrafts so unpublished guides are checked too — a draft you are about
  // to publish is exactly the one worth verifying.
  const guides = await getPublishedCityGuides({ includeDrafts: true });

  if (!guides.length) {
    console.log('No city guides found. Nothing to verify.');
    return;
  }

  console.log(`\n${guides.length} guide${guides.length === 1 ? '' : 's'}\n`);
  console.log('  status     slug            index  page   country');
  console.log('  ' + '-'.repeat(58));

  const mismatches: string[] = [];
  const reserved: string[] = [];

  for (const guide of guides) {
    // What the guide page itself would show — the authoritative number.
    const restaurants = await getFeaturedRestaurants(guide.slug).catch(() => []);
    const pageCount = restaurants.filter(isPubliclyVisible).length;
    const agrees = pageCount === guide.liveCount;
    if (!agrees) {
      mismatches.push(`${guide.slug}: /guides says ${guide.liveCount}, the page shows ${pageCount}`);
    }
    if (isReservedGuideSlug(guide.slug)) reserved.push(guide.slug);

    const status = guide.status === 'published' ? 'live ' : 'DRAFT';
    console.log(
      `  ${status}      ${guide.slug.padEnd(15)} ${String(guide.liveCount).padStart(5)}  ` +
        `${String(pageCount).padStart(5)}${agrees ? '  ' : ' ✗'} ${guide.country ?? '—'}`
    );
  }

  console.log('');

  if (reserved.length) {
    console.error(
      `✗ ${reserved.length} guide(s) sit on a reserved slug and are unreachable: ${reserved.join(', ')}`
    );
  }

  if (mismatches.length) {
    console.error(`✗ ${mismatches.length} count mismatch(es) — /guides and the guide pages disagree:`);
    for (const line of mismatches) console.error(`    ${line}`);
  } else {
    console.log(`✓ 0 mismatches — every guide's index count equals what its page renders.`);
  }

  const live = guides.filter((g) => g.status === 'published');
  const empty = live.filter((g) => g.liveCount === 0);
  if (empty.length) {
    // Not a failure, but worth seeing: a published guide with nothing live is a
    // page a visitor can reach and find empty.
    console.warn(
      `\n! ${empty.length} published guide(s) have no live restaurants: ${empty.map((g) => g.slug).join(', ')}`
    );
  }

  if (mismatches.length || reserved.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
