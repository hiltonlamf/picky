/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Seeds and parses the Dublin city guide restaurants automatically.
 */
export async function register() {
  // Only run in the Node.js runtime (not Edge), and not during next build
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
