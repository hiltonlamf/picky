-- Server-side spend aggregate.
--
-- Two reasons this must be a DB function rather than a PostgREST select:
--   1. PostgREST silently caps result sets at 1000 rows and a large `limit=`
--      does not override it, so `select cost_usd` + sum-in-JS under-reports
--      with no error once a day exceeds ~1000 AI calls (~90 restaurants).
--   2. The launch spend guard checks this on the request path; summing in
--      Postgres is one round trip instead of paging thousands of rows.
CREATE OR REPLACE FUNCTION ai_spend_since(since TIMESTAMPTZ)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::NUMERIC
  FROM ai_usage_log
  WHERE created_at >= since;
$$;

-- Postgres grants EXECUTE to PUBLIC by default and `anon` inherits it, so
-- revoking only from anon/authenticated leaves the function callable over
-- /rest/v1/rpc by anyone. Revoke from PUBLIC too. (See CLAUDE.md: this exact
-- omission left prune_parse_attempts world-callable.)
REVOKE ALL ON FUNCTION ai_spend_since(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
