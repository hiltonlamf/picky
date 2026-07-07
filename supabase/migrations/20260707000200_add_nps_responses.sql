-- NPS survey responses. Shown client-side from day 7 after a browser's
-- first successful analysis (localStorage-timestamped), once per browser.
-- Append-only, no FK — same reasoning as ai_usage_log and parse_attempts:
-- product-signal history must survive test wipes.

CREATE TABLE IF NOT EXISTS nps_responses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  anon_id     TEXT,
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nps_responses_created_at ON nps_responses (created_at);
