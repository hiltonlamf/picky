-- Per-IP budget for the free-but-floodable public write endpoints
-- (feedback, NPS, dish reports). These cost no AI money, so they are not on
-- the search budget in rate_limit_events — but they are unauthenticated
-- inserts, and flooding them pollutes the admin feedback inbox and the eval
-- ground truth we measure classification accuracy against.
CREATE TABLE IF NOT EXISTS write_rate_limit_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_hash    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS write_rate_limit_events_ip_kind_time_idx
  ON write_rate_limit_events(ip_hash, kind, created_at DESC);

-- Server-only, like every other table here: RLS on, ZERO policies, and grants
-- revoked so a stray "disable RLS" click cannot re-expose it. See CLAUDE.md.
ALTER TABLE write_rate_limit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE write_rate_limit_events FROM PUBLIC, anon, authenticated;
