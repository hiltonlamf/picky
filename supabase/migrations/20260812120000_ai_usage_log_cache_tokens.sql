-- Make prompt-cache hit rate answerable from the ledger.
--
-- tokens_in has always held the FULL prompt (uncached remainder + cache write +
-- cache read), and cost_usd has always priced the three parts correctly. What
-- was missing was the split: with only a total, there is no way to ask "did the
-- cache actually hit?" — the one question that decides whether prompt caching
-- is earning its place.
--
-- Zero is a meaningful value here, not a gap. Anthropic enforces a minimum
-- cacheable prefix that differs per model (4096 tokens on Haiku 4.5, 1024 on
-- Sonnet 4.6). Our shared system prompt is ~1.8k tokens, so on the Haiku path —
-- where nearly all extraction runs — a cache breakpoint is silently a no-op and
-- these columns correctly read 0. Rows from the Sonnet escalation path are
-- where a non-zero read should show up.
--
-- Default 0 rather than null so existing rows read as "no caching happened",
-- which is exactly what was true before this change.
alter table public.ai_usage_log
  add column if not exists cache_write_tokens integer not null default 0,
  add column if not exists cache_read_tokens  integer not null default 0;

comment on column public.ai_usage_log.cache_write_tokens is
  'Prompt tokens written to the cache on this call (billed at 1.25x). Included in tokens_in.';
comment on column public.ai_usage_log.cache_read_tokens is
  'Prompt tokens served from the cache on this call (billed at 0.1x). Included in tokens_in.';
