-- Passive parse-attempt telemetry. One row at the end of every real
-- discover/analyze call, success or failure — every user search becomes
-- free coverage data on which restaurant sites work and which fail.
--
-- Deliberately NO foreign key to restaurants (same reasoning as
-- ai_usage_log): wiping restaurants for fresh testing must never delete
-- the coverage history. Doubles as raw material for the accuracy-eval
-- golden set later.
--
-- stage distinguishes a discovery handoff (candidates found, analysis
-- continues in /analyze) from a terminal analysis outcome, so success
-- rates can be computed per stage without double counting.

CREATE TABLE IF NOT EXISTS parse_attempts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url           TEXT,
  domain        TEXT,
  stage         TEXT NOT NULL DEFAULT 'discover'
                  CHECK (stage IN ('discover', 'analyze')),
  category      TEXT,        -- pdf | image | js | text | multi (NULL before discovery)
  success       BOOLEAN NOT NULL,
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parse_attempts_created_at ON parse_attempts (created_at);
CREATE INDEX IF NOT EXISTS idx_parse_attempts_domain ON parse_attempts (domain);
