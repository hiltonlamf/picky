/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Initialises Sentry error monitoring. It can also seed and parse the Dublin
 * city guide, but ONLY when SEED_ON_BOOT=1 and never from a preview deployment
 * — see lib/guide-bootstrap.ts for why that is off by default.
 */
import * as Sentry from '@sentry/nextjs';
import { seedingEnabled } from './lib/guide-bootstrap';

export async function register() {
  // Sentry must init in every server runtime (Node and Edge) before anything else.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }

  // Dublin seeding only runs in the Node.js runtime, and not during next build
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.ANTHROPIC_API_KEY) return;

  // OFF unless explicitly asked for. This used to run on EVERY server start in
  // EVERY environment, which meant every preview deployment cold-started a
  // writer against the production database (previews share it — there is no
  // branch database) and spent AI money re-parsing restaurants. On 2026-09-08
  // that wiped the Dublin guide down to 3 visible restaurants.
  //
  // Nothing needs this to be automatic: guides are curated from
  // /admin/restaurants, and a fresh environment is seeded on purpose with
  // `npx tsx scripts/seed-dublin.ts`.
  const seeding = seedingEnabled();
  if (!seeding.bootstrap) {
    console.log(`[Picky] Boot seeding disabled — ${seeding.reason}`);
    return;
  }

  // Fire-and-forget — don't block the server from starting
  void seedDublinInBackground();
}

// Captures errors from nested React Server Components and server requests that
// never reach an application-level catch block.
export const onRequestError = Sentry.captureRequestError;

async function seedDublinInBackground() {
  try {
    const { initDublinRestaurants } = await import('./lib/init-dublin');
    await initDublinRestaurants();
  } catch (err) {
    // Instrumentation errors must not crash the server
    console.error('[Picky] Dublin init failed:', err instanceof Error ? err.message : err);
  }
}
