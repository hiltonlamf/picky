/**
 * When the boot seeder is allowed to write to a city guide.
 *
 * Pure and dependency-free on purpose: the decision that matters is easy to get
 * wrong and hard to observe, so it lives where it can be unit-tested rather than
 * inline in a fire-and-forget background task nobody watches.
 *
 * WHAT WENT WRONG (2026-09-08). The Dublin guide lost ~70 of its
 * featured_restaurants rows. A preview deployment cold-started, the boot seeder
 * ran against the PRODUCTION database, found the guide empty, and "helpfully"
 * re-seeded it with the first four entries of a hardcoded list — including a
 * restaurant with one dish. It then spent AI money re-parsing seed restaurants.
 * The guide went from ~70 restaurants to 3 visible ones.
 *
 * Three separate things had to be true for that to happen, so all three are
 * now closed:
 *   1. A preview deploy could run a writer against production.  -> seedingEnabled()
 *   2. A failed count read as "the guide is empty".             -> fail closed
 *   3. An empty guide was treated as "never set up".            -> the new rule
 */

export interface BootstrapDecision {
  bootstrap: boolean;
  /** Plain-language reason, logged either way so the choice is never silent. */
  reason: string;
}

export interface BootstrapInput {
  /** Rows already on this city's guide, or null if the query failed. */
  guideCount: number | null;
  /** Restaurants already analysed for this city, or null if the query failed. */
  analysedCount: number | null;
}

/**
 * Bootstrapping is for a genuinely empty database — the very first boot of a
 * fresh environment. Anything else is someone's curation, or an incident.
 */
export function shouldBootstrapGuide({ guideCount, analysedCount }: BootstrapInput): BootstrapDecision {
  // FAIL CLOSED. A null count means the query failed, and "I could not read the
  // guide" must never be mistaken for "the guide is empty". The old code did
  // `(guideCount ?? 0) === 0`, which turned any transient Supabase error into a
  // decision to re-seed.
  if (guideCount === null) {
    return { bootstrap: false, reason: 'could not read the guide — refusing to bootstrap' };
  }
  if (analysedCount === null) {
    return { bootstrap: false, reason: 'could not count analysed restaurants — refusing to bootstrap' };
  }

  if (guideCount > 0) {
    return { bootstrap: false, reason: `guide already lists ${guideCount} restaurant(s)` };
  }

  // THE RULE THAT WOULD HAVE PREVENTED THIS. An empty guide in a database that
  // already holds analysed restaurants for the city is not a fresh install —
  // it is a guide that has been emptied, whether by an admin or by an accident.
  // Re-seeding ten hardcoded restaurants over the top of it destroys the
  // evidence and puts a near-empty guide in front of visitors. Leave it alone
  // and let a human decide.
  if (analysedCount > 0) {
    return {
      bootstrap: false,
      reason: `guide is empty but ${analysedCount} analysed restaurant(s) exist — this is an emptied guide, not a new one`,
    };
  }

  return { bootstrap: true, reason: 'empty guide in an empty database — first-run bootstrap' };
}

/**
 * Whether the boot seeder may run at all.
 *
 * OFF by default, everywhere. It used to run on every server start in every
 * environment, which meant every preview deployment booted a writer against the
 * production database (previews share it — there is no branch database) and
 * spent AI money re-parsing restaurants on a cold start.
 *
 * Guide membership is curated from /admin/restaurants now, and a fresh
 * environment is seeded with `npx tsx scripts/seed-dublin.ts`. Nothing needs
 * this to happen automatically, so it has to be asked for explicitly:
 * SEED_ON_BOOT=1, and never on a preview deployment.
 */
export function seedingEnabled(env: NodeJS.ProcessEnv = process.env): BootstrapDecision {
  if (env.SEED_ON_BOOT !== '1') {
    return { bootstrap: false, reason: 'SEED_ON_BOOT is not set' };
  }
  // Belt and braces, like the RLS lockdown: even with the flag on, a preview
  // must never write to the production database it happens to share.
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
    return { bootstrap: false, reason: `refusing to seed from a ${env.VERCEL_ENV} deployment` };
  }
  return { bootstrap: true, reason: 'SEED_ON_BOOT=1' };
}
