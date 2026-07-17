import { PostHog } from 'posthog-node';

let _client: PostHog | null = null;

function client(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!_client) {
    _client = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
      // Serverless: batching in memory loses events when the function
      // freezes, so send each event immediately.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _client;
}

/**
 * Server-side event capture. Awaits the flush so the event leaves the
 * function before Vercel suspends it. Never throws — analytics must not
 * break the request it's riding on.
 */
export async function captureServer(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  const ph = client();
  if (!ph) return;
  try {
    ph.capture({ distinctId, event, properties });
    await ph.flush();
  } catch {
    // swallow — see above
  }
}
