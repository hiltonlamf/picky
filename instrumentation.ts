/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Initializes Sentry error monitoring, then seeds and parses the
 * Dublin city guide restaurants automatically.
 */
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

  // Fire-and-forget — don't block the server from starting
  void seedDublinInBackground();
}

async function seedDublinInBackground() {
  try {
    const { initDublinRestaurants } = await import('./lib/init-dublin');
    await initDublinRestaurants();
  } catch (err) {
    // Instrumentation errors must not crash the server
    console.error('[Picky] Dublin init failed:', err instanceof Error ? err.message : err);
  }
}
