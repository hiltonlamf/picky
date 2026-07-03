-- ============================================================
-- Picky — Cost & Usage Monitoring Queries
-- Run these in Supabase → SQL Editor
-- ============================================================

-- ── Total spend and parse volume (all time, wipe-proof) ─────
-- ai_usage_log is append-only and survives restaurant wipes — this is the
-- authoritative spend history (includes backfilled pre-wipe rows).
SELECT
  COUNT(*)                          AS total_parses,
  SUM(cost_usd)                     AS total_cost_usd,
  AVG(cost_usd)                     AS avg_cost_per_parse,
  SUM(tokens_in)                    AS total_tokens_in,
  SUM(tokens_out)                   AS total_tokens_out
FROM ai_usage_log;


-- ── Spend by week from the wipe-proof log ────────────────────
SELECT
  DATE_TRUNC('week', created_at)::date AS week,
  COUNT(*)                             AS parses,
  ROUND(SUM(cost_usd)::numeric, 4)     AS cost_usd
FROM ai_usage_log
GROUP BY 1
ORDER BY 1 DESC;


-- ── Total spend on CURRENT restaurant rows (does not survive wipes) ──
SELECT
  COUNT(*)                          AS total_parses,
  SUM(cost_usd)                     AS total_cost_usd,
  AVG(cost_usd)                     AS avg_cost_per_parse,
  SUM(tokens_in)                    AS total_tokens_in,
  SUM(tokens_out)                   AS total_tokens_out
FROM restaurants
WHERE status = 'done' AND cost_usd IS NOT NULL;


-- ── Spend by day (last 30 days) ─────────────────────────────
SELECT
  DATE(last_scraped_at)             AS day,
  COUNT(*)                          AS parses,
  ROUND(SUM(cost_usd)::numeric, 4)  AS cost_usd,
  SUM(tokens_in)                    AS tokens_in,
  SUM(tokens_out)                   AS tokens_out
FROM restaurants
WHERE status = 'done'
  AND last_scraped_at >= NOW() - INTERVAL '30 days'
  AND cost_usd IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;


-- ── Model usage split ────────────────────────────────────────
SELECT
  model_used,
  COUNT(*)                          AS parses,
  ROUND(AVG(cost_usd)::numeric, 5)  AS avg_cost_usd,
  ROUND(SUM(cost_usd)::numeric, 4)  AS total_cost_usd
FROM restaurants
WHERE status = 'done' AND model_used IS NOT NULL
GROUP BY model_used
ORDER BY total_cost_usd DESC;


-- ── Most expensive parses (longest menus) ───────────────────
SELECT
  name,
  url,
  model_used,
  tokens_in,
  tokens_out,
  ROUND(cost_usd::numeric, 5)  AS cost_usd,
  last_scraped_at
FROM restaurants
WHERE status = 'done' AND cost_usd IS NOT NULL
ORDER BY cost_usd DESC
LIMIT 20;


-- ── Cache hit rate ───────────────────────────────────────────
-- "cache hits" = requests that returned a result without hitting the AI
-- Proxy: restaurants with status=done but no new cost in the last hour
-- (true cache hits don't create a new row, so this measures new parses vs total)
SELECT
  COUNT(*)                                        AS total_done_restaurants,
  COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)    AS parsed_with_ai,
  COUNT(*) FILTER (WHERE cost_usd IS NULL)        AS cached_or_unknown
FROM restaurants
WHERE status = 'done';


-- ── Estimated monthly cost at scale ─────────────────────────
-- Change :daily_visits to your expected daily unique-URL parses
WITH daily AS (
  SELECT AVG(cost_usd) AS avg_cost
  FROM restaurants
  WHERE status = 'done' AND cost_usd IS NOT NULL
)
SELECT
  ROUND((avg_cost * 100)::numeric, 2)   AS monthly_cost_at_100_parses_per_day,
  ROUND((avg_cost * 500)::numeric, 2)   AS monthly_cost_at_500_parses_per_day,
  ROUND((avg_cost * 2000)::numeric, 2)  AS monthly_cost_at_2000_parses_per_day
FROM daily;


-- ── User report activity ─────────────────────────────────────
SELECT
  d.name                        AS dish,
  r.name                        AS restaurant,
  d.classification,
  d.report_count,
  d.warning_flagged
FROM dishes d
JOIN restaurants r ON r.id = d.restaurant_id
WHERE d.report_count > 0
ORDER BY d.report_count DESC
LIMIT 50;


-- ── Parse error rate ─────────────────────────────────────────
SELECT
  status,
  COUNT(*) AS count
FROM restaurants
GROUP BY status
ORDER BY count DESC;
