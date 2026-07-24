-- WHY: The feedback pipeline is moving from open-ended ("something's wrong" +
-- free text) to deterministic capture the admin can accept in one click. A dish
-- report now carries the label the user thinks it should be; a page report can
-- carry a proposed dish name (missing dish), a corrected restaurant name (wrong
-- name), which menu it's about (not-a-menu), and a link to a menu we missed.
-- resolution_action records what an admin's Accept actually did, so the Errors
-- tab / export becomes a single fix-at-scale ledger.
--
-- All additive + idempotent (ADD COLUMN IF NOT EXISTS) on the existing wipe-safe
-- no-FK feedback tables, so this is safe to re-run and can't touch spend history.

ALTER TABLE dish_reports
  ADD COLUMN IF NOT EXISTS proposed_classification TEXT
    CHECK (proposed_classification IN ('vegan','vegetarian','neither','unknown')),
  ADD COLUMN IF NOT EXISTS resolution_action TEXT;

ALTER TABLE restaurant_feedback
  ADD COLUMN IF NOT EXISTS proposed_classification TEXT
    CHECK (proposed_classification IN ('vegan','vegetarian','neither','unknown')),
  ADD COLUMN IF NOT EXISTS proposed_dish_name TEXT,
  ADD COLUMN IF NOT EXISTS proposed_name TEXT,   -- corrected restaurant name (wrong_name)
  ADD COLUMN IF NOT EXISTS menu_label TEXT,       -- which menu a menu-level report is about
  -- User-provided link to a menu we missed. Reference ONLY — the pipeline never
  -- auto-fetches this; an admin opens it by hand (avoids a client-controlled
  -- server-side fetch / SSRF).
  ADD COLUMN IF NOT EXISTS reference_url TEXT,
  ADD COLUMN IF NOT EXISTS resolution_action TEXT;
