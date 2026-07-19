-- Admin dashboard + eval infrastructure: a durable, auto-growing golden set
-- (eval_cases/eval_menu_candidates/eval_dishes), live-correction support on
-- dishes (human_verified/reviewer_notes so a hand-fix survives a reparse),
-- and feedback triage verdicts (status/resolution_notes/resolved_at) on the
-- two existing feedback tables. See /Users/hiltonlam/.claude/plans/logical-seeking-nebula.md
-- for full design rationale.

-- Durable golden set — NOT FK'd to restaurants (same wipe-proof pattern as
-- ai_usage_log / restaurant_feedback): must survive a wipe or the restaurant
-- being deleted/reprocessed. Auto-created the first time a dish under that
-- restaurant's URL gets a human verdict.
CREATE TABLE eval_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url TEXT NOT NULL,
  name TEXT,
  city TEXT,
  missed_menus TEXT, -- free text: real menus on the site the pipeline never found
  notes TEXT,
  menus_reviewed_at TIMESTAMPTZ, -- set when a human confirms this restaurant's menu discovery is correct (menu-level review)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX eval_cases_url_unique ON eval_cases (lower(url));

CREATE TABLE eval_menu_candidates ( -- discovery-review verdicts
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  eval_case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'spurious', 'duplicate')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE eval_dishes ( -- auto-grown, human-validated ground truth
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  eval_case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  menu_label TEXT,
  section_name TEXT,
  name TEXT NOT NULL,
  expected_classification TEXT NOT NULL CHECK (expected_classification IN ('vegan','vegetarian','neither','unknown')),
  -- What the AI originally guessed at the moment a human gave a verdict, captured
  -- BEFORE the live dish is overwritten. This is what makes dish accuracy honest:
  -- accuracy = % where ai_original_classification == expected_classification.
  -- Nullable: rows created before this column existed / by paths that don't know it.
  ai_original_classification TEXT CHECK (ai_original_classification IN ('vegan','vegetarian','neither','unknown')),
  source TEXT NOT NULL DEFAULT 'admin_review' CHECK (source IN ('admin_review','feedback_confirmed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX eval_dishes_case_name_unique ON eval_dishes (eval_case_id, lower(name));

-- Live-correction support: preserves human fixes/adds/removals across reparses.
ALTER TABLE dishes
  ADD COLUMN human_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN reviewer_notes TEXT;

-- Feedback triage verdicts.
ALTER TABLE dish_reports
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
  ADD COLUMN resolution_notes TEXT,
  ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE restaurant_feedback
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
  ADD COLUMN resolution_notes TEXT,
  ADD COLUMN resolved_at TIMESTAMPTZ;
