// Measure our shared prompts against each model's MINIMUM CACHEABLE PREFIX.
//
// FREE: uses /v1/messages/count_tokens, which does no generation and is not
// billed. Run it as often as you like.
//
//   npx tsx scripts/count-prompt-tokens.ts
//
// Why this exists: a `cache_control` marker on a prefix shorter than the
// model's minimum is a SILENT no-op — no error, no warning, just
// cache_creation_input_tokens: 0 forever. The minimum is not intuitive and is
// not monotonic across model generations, so the only safe way to know whether
// caching can work is to measure. Anthropic's published minimums:
//
//   Haiku 4.5    4096 tokens   <- our DISCOVERY_MODEL and EXTRACTION_MODEL
//   Sonnet 4.6   1024 tokens   <- our ESCALATION_MODEL
//
// If the "shortfall" line ever reaches zero for Haiku, prompt caching switches
// on across the whole extraction path with no code change.
//
// Note: this calls /v1/messages/count_tokens over plain fetch rather than
// through callClaude(). That is deliberate and is NOT a cost-tracking bypass —
// count_tokens does no generation and is never billed, so there is no spend to
// record. The pinned SDK (0.27.x) has no countTokens binding either way.
import './_preload-env';
import { SYSTEM_PROMPT, DISCOVERY_MODEL, EXTRACTION_MODEL, ESCALATION_MODEL } from '@/lib/ai';

/** Anthropic's minimum cacheable prefix, per model. A prefix shorter than this
 *  cannot be cached at all. Keep in sync with the caching docs when we change
 *  models — an out-of-date entry here makes the report confidently wrong. */
const MIN_CACHEABLE: Record<string, number> = {
  'claude-haiku-4-5-20251001': 4096,
  'claude-sonnet-4-6': 1024,
};

async function countTokens(apiKey: string, model: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      system: SYSTEM_PROMPT,
      // count_tokens requires at least one message; this one-word user turn
      // adds a handful of tokens, so treat the figure as "system prompt plus a
      // trivial turn" rather than the system prompt in perfect isolation.
      messages: [{ role: 'user', content: 'x' }],
    }),
  });
  if (!res.ok) {
    throw new Error(`count_tokens failed for ${model}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { input_tokens: number };
  return body.input_tokens;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set (check .env.local).');
    process.exit(1);
  }

  // Unique models, in tiering order, so a shared model is only measured once.
  const models = Array.from(new Set([DISCOVERY_MODEL, EXTRACTION_MODEL, ESCALATION_MODEL]));

  console.log(`\nSYSTEM_PROMPT — ${SYSTEM_PROMPT.length.toLocaleString()} characters\n`);

  for (const model of models) {
    const tokens = await countTokens(apiKey, model);
    const min = MIN_CACHEABLE[model];
    const label = model.padEnd(28);

    if (min === undefined) {
      console.log(`${label} ${String(tokens).padStart(6)} tokens   (no known minimum — add it to MIN_CACHEABLE)`);
      continue;
    }

    const cacheable = tokens >= min;
    const verdict = cacheable
      ? `CACHEABLE (${tokens - min} tokens above the ${min} minimum)`
      : `NOT CACHEABLE — ${min - tokens} tokens short of the ${min} minimum`;
    console.log(`${label} ${String(tokens).padStart(6)} tokens   ${verdict}`);
  }

  console.log(
    '\nA "NOT CACHEABLE" line means the cache_control marker on that path does\n' +
      'nothing, silently. That is the expected state for Haiku today — see the\n' +
      'CACHED_SYSTEM comment in lib/ai.ts.\n'
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
