-- Separate what serving users costs from what testing costs.
--
-- Both are real money the founder pays, so both belong in the ledger — but they
-- answer different questions, and until now the only way to tell them apart was
-- a naming convention in restaurant_name ('QA: Tofu Vegan'). A string prefix is
-- not something to make budget decisions on: anyone totalling ai_usage_log for
-- "what does the product cost to run" would silently include every QA run.
--
-- Default 'product' so existing rows keep their meaning: everything logged
-- before this migration came from the app serving real traffic, because CI had
-- no database credentials and therefore never wrote a row.
alter table public.ai_usage_log
  add column if not exists source text not null default 'product';

comment on column public.ai_usage_log.source is
  'product = the app serving a visitor; qa = live pipeline QA and spend-verification runs.';

-- Totals are almost always sliced by source and month.
create index if not exists ai_usage_log_source_created_idx
  on public.ai_usage_log (source, created_at desc);
