-- Anonymous per-browser usage ID (monetization groundwork).
--
-- A plain persistent UUID set as a 1-year cookie by middleware.ts —
-- deliberately NOT the per-request IP hash used for rate limiting, which
-- can't identify a browser over time. Attached to feedback and dish
-- reports so usage-per-person can be measured; usage history can't be
-- reconstructed retroactively, so capture starts now even though billing
-- is out of scope.

ALTER TABLE restaurant_feedback
  ADD COLUMN IF NOT EXISTS anon_id TEXT;

ALTER TABLE dish_reports
  ADD COLUMN IF NOT EXISTS anon_id TEXT;
