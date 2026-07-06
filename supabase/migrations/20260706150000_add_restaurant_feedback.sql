-- General product feedback (missing dish, wrong menu, feature requests...),
-- separate from dish_reports which is always about one specific dish's label.
--
-- WHY: restaurant_id is deliberately NOT a foreign key, same reasoning as
-- ai_usage_log — wiping restaurants for fresh testing must never delete
-- genuine user feedback, especially feature requests that outlive any one
-- restaurant's data.

CREATE TABLE IF NOT EXISTS restaurant_feedback (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID,        -- reference only; intentionally NOT a FK
  restaurant_name TEXT,
  feedback_type   TEXT NOT NULL,
  notes           TEXT,
  ip_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_feedback_created_at ON restaurant_feedback(created_at);
