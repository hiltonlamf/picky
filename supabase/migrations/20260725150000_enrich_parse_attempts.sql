-- Make parse_attempts answer "which restaurant did someone search, and what did
-- they get?" — the founder's request (2026-07-25).
--
-- Why here rather than in PostHog: parse_attempts is NOT consent-gated, so it
-- captures 100% of searches instead of only the consenting 40–70%. A list of what
-- people search for that silently omits half the searches would mislead every
-- product decision it touched. This was proven in practice the same day: a real
-- analysis of nezha.ie by someone who never accepted cookies produced no PostHog
-- events at all (correctly), yet parse_attempts captured it — and that row is
-- what diagnosed the failure.
--
-- Different legal basis, too: "how our service performed on a URL" is operating
-- the product, not third-party behavioural profiling. Full URLs therefore stay in
-- our own database and PostHog keeps only the domain.

ALTER TABLE parse_attempts
  -- Ties the two stage rows (discover + analyze) into one person's search, and
  -- joins to PostHog and the feedback tables, which key on the same ID.
  ADD COLUMN IF NOT EXISTS anon_id     UUID,
  -- The response they actually got. This is the difference between "worked" and
  -- "worked but returned 3 dishes", which is the failure users notice most.
  ADD COLUMN IF NOT EXISTS dish_count  INTEGER,
  -- Stable outcome taxonomy so this is countable rather than free text.
  ADD COLUMN IF NOT EXISTS outcome     TEXT
    CHECK (outcome IS NULL OR outcome IN ('menu', 'no_menu', 'error', 'thin')),
  -- Mirrors classifyError() in lib/telemetry.ts. Grouping by raw error_message
  -- yields fifty one-offs; grouping by code yields five real problems.
  ADD COLUMN IF NOT EXISTS error_code  TEXT;

-- The admin view reads recent-first and filters by outcome.
CREATE INDEX IF NOT EXISTS idx_parse_attempts_outcome ON parse_attempts (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parse_attempts_anon_id ON parse_attempts (anon_id);

-- Retention: 180 days (founder's decision, 2026-07-25). url + anon_id together
-- are pseudonymous personal data, so they should not be kept indefinitely.
-- Exposed as a function rather than a pg_cron job so it works whether or not the
-- extension is enabled, and so a deletion is always a deliberate, auditable call.
CREATE OR REPLACE FUNCTION prune_parse_attempts(retain_days INTEGER DEFAULT 180)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM parse_attempts
   WHERE created_at < NOW() - (retain_days || ' days')::INTERVAL;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMENT ON FUNCTION prune_parse_attempts IS
  'Deletes parse_attempts rows older than retain_days (default 180). Retention policy set 2026-07-25. Run via scripts/prune-parse-attempts.ts.';
