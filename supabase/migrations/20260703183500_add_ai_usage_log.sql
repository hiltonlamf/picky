-- Append-only API-spend log. One row per completed analysis.
--
-- WHY: cost columns previously lived only ON restaurants rows, so wiping
-- restaurants for fresh testing destroyed the spend history (2026-07-02).
-- This table deliberately has NO foreign key to restaurants — deleting a
-- restaurant must never delete its cost record.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID,        -- reference only; intentionally NOT a FK
  restaurant_name TEXT,
  url             TEXT,
  model_used      TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        NUMERIC(10, 6),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON ai_usage_log (created_at);
