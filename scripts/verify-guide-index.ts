// Verify the city-guide index against live data, and explain any shortfall.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping — it re-reads what
// is already in the database. Run it as often as you like.
//
//   npx tsx scripts/verify-guide-index.ts
//
// It answers two different questions.
//
// **"Is this number right?"** — it cross-checks, guide by guide, that the count
// on /guides equals what the guide page itself renders. Those are two code
// paths reaching the same figure: /guides batches the bare minimum in five
// queries, while the page loads whole restaurants and filters them. If they
// ever disagree, /guides advertises a number the page then contradicts — the
// same class of bug as a restaurant showing two different veggie counts. Unit
// tests cover the logic; only this can check the QUERIES. Exits non-zero.
//
// **"Why is the number that size?"** — a guide showing 25 of 40 is either a
// content gap (only 25 were ever curated in) or a pipeline bug (15 are being
// held back). Those look identical from the outside and want completely
// different responses, so it prints the total, the live count, and every
// held-back restaurant with its reason. A pile of restaurants sharing one
// reason is the bug signal.
import './_preload-env';
import { getPublishedCityGuides, getFeaturedRestaurants } from '@/lib/db';
import { heldBackReason, isPubliclyVisible } from '@/lib/review-flags';
import { isReservedGuideSlug } from '@/lib/city-guides';
import type { Restaurant } from '@/types';

/** Groups held-back restaurants by reason, most common first — the shape of the
 *  shortfall matters more than the individual rows. */
function byReason(restaurants: Restaurant[]): Array<{ reason: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const r of restaurants) {
    const reason = r.guideHidden ? 'hidden by hand' : heldBackReason(r) ?? 'held back for review';
    const names = groups.get(reason);
    if (names) names.push(r.name ?? r.url);
    else groups.set(reason, [r.name ?? r.url]);
  }
  return Array.from(groups.entries())
    .map(([reason, names]) => ({ reason, names }))
    .sort((a, b) => b.names.length - a.names.length);
}

async function main() {
  // includeDrafts so unpublished guides are checked too — a draft you are about
  // to publish is exactly the one worth verifying.
  const guides = await getPublishedCityGuides({ includeDrafts: true });

  if (!guides.length) {
    console.log('No city guides found. Nothing to verify.');
    return;
  }

  console.log(`\n${guides.length} guide${guides.length === 1 ? '' : 's'}\n`);
  console.log('  status   slug             total   live   held   page   country');
  console.log('  ' + '-'.repeat(66));

  const mismatches: string[] = [];
  const reserved: string[] = [];
  const shortfalls: Array<{ slug: string; groups: ReturnType<typeof byReason> }> = [];

  for (const guide of guides) {
    // includeHidden so `total` is everything curated into the guide, which is
    // the denominator the live count only makes sense against.
    const all = await getFeaturedRestaurants(guide.slug, { includeHidden: true }).catch(
      (): Restaurant[] => []
    );
    const live = all.filter((r) => !r.guideHidden && isPubliclyVisible(r));
    const held = all.filter((r) => r.guideHidden || !isPubliclyVisible(r));

    // What the public page renders, by the same path the page uses.
    const pageCount = (await getFeaturedRestaurants(guide.slug).catch((): Restaurant[] => []))
      .filter(isPubliclyVisible).length;
    const agrees = pageCount === guide.liveCount && pageCount === live.length;
    if (!agrees) {
      mismatches.push(
        `${guide.slug}: /guides says ${guide.liveCount}, the page shows ${pageCount}, this script counts ${live.length}`
      );
    }
    if (isReservedGuideSlug(guide.slug)) reserved.push(guide.slug);
    if (held.length) shortfalls.push({ slug: guide.slug, groups: byReason(held) });

    const status = guide.status === 'published' ? 'live ' : 'DRAFT';
    console.log(
      `  ${status}    ${guide.slug.padEnd(15)} ${String(all.length).padStart(5)}  ` +
        `${String(live.length).padStart(5)}  ${String(held.length).padStart(5)}  ` +
        `${String(pageCount).padStart(5)}${agrees ? '  ' : ' ✗'} ${guide.country ?? '—'}`
    );
  }

  // The part that actually answers "why is it only N?".
  for (const { slug, groups } of shortfalls) {
    const total = groups.reduce((n, g) => n + g.names.length, 0);
    console.log(`\n  ${slug} — ${total} not showing:`);
    for (const { reason, names } of groups) {
      console.log(`    ${String(names.length).padStart(3)}  ${reason}`);
      for (const name of names) console.log(`         · ${name}`);
    }
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

  const empty = guides.filter((g) => g.status === 'published' && g.liveCount === 0);
  if (empty.length) {
    // Not a failure, but worth seeing: a published guide with nothing live is a
    // page a visitor can reach and find empty.
    console.warn(
      `! ${empty.length} published guide(s) have no live restaurants: ${empty.map((g) => g.slug).join(', ')}`
    );
  }

  // A guide where most of the curated list is held back is a pipeline problem,
  // not a content gap — say so rather than leaving it to be read off the table.
  for (const { slug, groups } of shortfalls) {
    const heldCount = groups.reduce((n, g) => n + g.names.length, 0);
    const guide = guides.find((g) => g.slug === slug);
    const total = heldCount + (guide?.liveCount ?? 0);
    if (total >= 5 && heldCount > total / 2) {
      console.warn(
        `! ${slug}: ${heldCount} of ${total} curated restaurants are not showing — ` +
          `that is more likely a pipeline problem than a run of restaurants without menus.`
      );
    }
  }

  if (mismatches.length || reserved.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
