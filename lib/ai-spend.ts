import { AsyncLocalStorage } from 'node:async_hooks';
import type { AIUsage } from './ai';

/**
 * Spend recording for every Anthropic API call.
 *
 * Why this exists: `ai_usage_log` was under-reporting July spend roughly 8×
 * ($5.46 logged against $45+ on the Console). The cause was structural, not a
 * pricing error — the extraction helpers were typed
 * `Promise<{ menu; usage } | null>`, so on any failure they returned `null`, a
 * shape that *cannot carry usage*. The call had already been billed; the number
 * was simply dropped. Since failures escalate Haiku → Sonnet (3× the price),
 * the most expensive path in the pipeline logged nothing at all. Two more call
 * sites (labelMenuCandidates, resolveViaClaudeLLM) never recorded usage in the
 * first place.
 *
 * The fix is a single choke point — see `callClaude` in ./ai — that records
 * usage the moment the API returns, *before* any parsing or validation runs.
 * No early return, thrown error, or future code path can lose it, and adding a
 * new AI call can't accidentally opt out.
 *
 * Restaurant attribution is carried in AsyncLocalStorage rather than threaded
 * through every function signature. Deliberately **degrades safely**: with no
 * context set, the row is still written with a null restaurant_id. Forgetting
 * to wrap an entry point costs attribution, never the spend total — which is
 * the number that actually matters.
 */

export type SpendContext = {
  restaurantId?: string | null;
  url?: string | null;
  restaurantName?: string | null;
};

const store = new AsyncLocalStorage<SpendContext>();

/** Attribute every AI call inside `fn` to a restaurant. Safe to nest and to omit. */
export function withSpendContext<T>(ctx: SpendContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/**
 * Append one row to `ai_usage_log`.
 *
 * Awaited rather than fire-and-forget: on Vercel the function can freeze the
 * moment the response is sent, and a detached insert would be lost — the same
 * reason posthog-server flushes synchronously. A Supabase insert is ~50ms
 * against an AI call measured in seconds, so the overhead is noise, and this is
 * money we're accounting for.
 *
 * Never throws — logUsage swallows its own errors. Losing a spend row must not
 * fail a user's analysis.
 */
export async function recordSpend(usage: AIUsage): Promise<void> {
  const ctx = store.getStore() ?? {};
  try {
    // Imported lazily: lib/db imports lib/ai, so a top-level import here would
    // close a require cycle.
    const { logUsage } = await import('./db');
    await logUsage(ctx.restaurantId ?? null, ctx.url ?? null, usage, ctx.restaurantName ?? null);
  } catch {
    // Best effort by design.
  }
}
