// Explain what each city guide is showing, and why.
//
// READ-ONLY and FREE: no AI calls, no writes, no re-scraping — it re-reads what
// is already in the database. Run it as often as you like.
//
//   npx tsx scripts/verify-guide-index.ts
//
// It answers "why is this guide only showing N restaurants?" — a guide with 40
// curated and 25 showing is either a content gap (only 25 were ever worth
// publishing) or a pipeline bug (15 are being held back). Those look identical
// from the outside and want completely different responses, so it prints the
// total, the live count, and every held-back restaurant with its reason. A pile
// of restaurants sharing one reason is the bug signal.
//
// It used to ALSO cross-check the count on /guides against what each page
// renders. That check is gone because the number is gone: /guides no longer
// advertises a restaurant count, so there is no longer a second figure to
// disagree with the page. (The check was right to exist — the count it guarded
// was silently truncated by PostgREST's 1000-row cap, which is exactly what it
// would have caught had it ever been run against live data.)
import './_preload-env';
import { listCityGuideLinks, getFeaturedRestaurants } from '@/lib/db';
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
  const guides = await listCityGuideLinks({ includeDrafts: true });

  if (!guides.length) {
    console.log('No city guides found. Nothing to verify.');
    return;
  }

  console.log(`\n${guides.length} guide${guides.length === 1 ? '' : 's'}\n`);
  console.log('  status   slug             total   live   held   country');
  console.log('  ' + '-'.repeat(60));

  const reserved: string[] = [];
  const shortfalls: Array<{ slug: string; groups: ReturnType<typeof byReason> }> = [];
  // Counted here rather than read off the guide row: the number the guide page
  // renders is only knowable by running the page's own filter over its own
  // restaurants, which is exactly what this loop does.
  const liveBySlug = new Map<string, number>();
  const emptyPublished: string[] = [];

  for (const guide of guides) {
    // includeHidden so `total` is everything curated into the guide, which is
    // the denominator the live count only makes sense against.
    const all = await getFeaturedRestaurants(guide.slug, { includeHidden: true }).catch(
      (): Restaurant[] => []
    );
    const live = all.filter((r) => !r.guideHidden && isPubliclyVisible(r));
    const held = all.filter((r) => r.guideHidden || !isPubliclyVisible(r));

    liveBySlug.set(guide.slug, live.length);
    if (guide.status === 'published' && live.length === 0) emptyPublished.push(guide.slug);
    if (isReservedGuideSlug(guide.slug)) reserved.push(guide.slug);
    if (held.length) shortfalls.push({ slug: guide.slug, groups: byReason(held) });

    const status = guide.status === 'published' ? 'live ' : 'DRAFT';
    console.log(
      `  ${status}    ${guide.slug.padEnd(15)} ${String(all.length).padStart(5)}  ` +
        `${String(live.length).padStart(5)}  ${String(held.length).padStart(5)}   ${guide.country ?? '—'}`
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

  if (emptyPublished.length) {
    // Not a failure, but worth seeing: a published guide with nothing live is a
    // page a visitor can reach and find empty. Nothing on the public site says
    // so any more, so this is the place it surfaces.
    console.warn(
      `! ${emptyPublished.length} published guide(s) have no live restaurants: ${emptyPublished.join(', ')}`
    );
  }

  // A guide where most of the curated list is held back is a pipeline problem,
  // not a content gap — say so rather than leaving it to be read off the table.
  for (const { slug, groups } of shortfalls) {
    const heldCount = groups.reduce((n, g) => n + g.names.length, 0);
    const total = heldCount + (liveBySlug.get(slug) ?? 0);
    if (total >= 5 && heldCount > total / 2) {
      console.warn(
        `! ${slug}: ${heldCount} of ${total} curated restaurants are not showing — ` +
          `that is more likely a pipeline problem than a run of restaurants without menus.`
      );
    }
  }

  if (reserved.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
