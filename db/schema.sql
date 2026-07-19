-- Run this in your Supabase SQL Editor to set up the Picky database schema.
-- Go to: Supabase Dashboard → SQL Editor → New Query → paste this → Run

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Core Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS restaurants (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url               TEXT NOT NULL,
  canonical_url     TEXT,
  name              TEXT,
  city              TEXT NOT NULL DEFAULT 'dublin',
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'error')),
  error_message     TEXT,
  menu_url          TEXT,
  last_scraped_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_sections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  menu_label      TEXT, -- source menu (Lunch/Dinner/...); NULL for single-menu restaurants
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe for existing schemas (mirrors supabase/migrations/20260702090000_add_menu_label.sql)
ALTER TABLE menu_sections
  ADD COLUMN IF NOT EXISTS menu_label TEXT;

CREATE TABLE IF NOT EXISTS dishes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  section_id        UUID REFERENCES menu_sections(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  price             TEXT,
  classification    TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (classification IN ('vegan', 'vegetarian', 'neither', 'unknown')),
  confidence        FLOAT NOT NULL DEFAULT 0.5
                      CHECK (confidence BETWEEN 0 AND 1),
  confidence_reason TEXT,
  report_count      INTEGER NOT NULL DEFAULT 0,
  warning_flagged   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provenance + soft-delete (see 20260718120000_add_dish_provenance.sql).
  origin            TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'admin')),
  ai_classification TEXT CHECK (ai_classification IN ('vegan', 'vegetarian', 'neither', 'unknown')),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dish_reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dish_id     UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  issue_type  TEXT NOT NULL,
  notes       TEXT,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- General product feedback (missing dish, wrong menu, feature requests...),
-- distinct from dish_reports which is always about one specific dish's label.
-- restaurant_id is deliberately NOT a foreign key, same reasoning as
-- ai_usage_log: wiping restaurants for fresh testing must never delete
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

-- City guide featured restaurants
CREATE TABLE IF NOT EXISTS featured_restaurants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  city            TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rate limiting (simple IP-hash based)
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_hash     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AI cost tracking columns (migration — safe to run on existing schema)
-- ============================================================

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS model_used  TEXT,
  ADD COLUMN IF NOT EXISTS tokens_in   INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_out  INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd    NUMERIC(10, 6);

-- Append-only API-spend log (mirrors supabase/migrations/20260703183500_add_ai_usage_log.sql).
-- One row per completed analysis. Deliberately NO foreign key to restaurants:
-- wiping restaurants for fresh testing must never delete the cost history.
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

-- Multi-menu disambiguation: discovered candidate menus held between the
-- discover and analyze phases (the analyze step references these by id only).
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS menu_candidates JSONB,
  ADD COLUMN IF NOT EXISTS candidates_at   TIMESTAMPTZ;

-- Passive parse-attempt telemetry (mirrors
-- supabase/migrations/20260707000000_add_parse_attempts.sql).
-- One row at the end of every real discover/analyze call, success or
-- failure. Deliberately NO foreign key to restaurants, same reasoning as
-- ai_usage_log: coverage history must survive test wipes. stage
-- distinguishes a discovery handoff from a terminal analysis outcome.
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

-- Anonymous per-browser usage ID (mirrors
-- supabase/migrations/20260707000100_add_anon_id.sql). A persistent
-- 1-year cookie UUID — distinct from ip_hash, which is per-request abuse
-- control. Monetization groundwork: usage-per-person capture starts now.
ALTER TABLE restaurant_feedback
  ADD COLUMN IF NOT EXISTS anon_id TEXT;

ALTER TABLE dish_reports
  ADD COLUMN IF NOT EXISTS anon_id TEXT;

-- NPS survey responses (mirrors
-- supabase/migrations/20260707000200_add_nps_responses.sql). Shown from
-- day 7 after a browser's first successful analysis, once per browser.
-- Append-only, no FK — product-signal history must survive test wipes.
CREATE TABLE IF NOT EXISTS nps_responses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  anon_id     TEXT,
  score       INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nps_responses_created_at ON nps_responses (created_at);

-- ============================================================
-- Admin dashboard + eval infrastructure (mirrors
-- supabase/migrations/20260708103000_add_eval_and_review.sql)
-- ============================================================

-- Durable golden set — NOT FK'd to restaurants (same wipe-proof pattern as
-- ai_usage_log / restaurant_feedback): must survive a wipe or the restaurant
-- being deleted/reprocessed. Auto-created the first time a dish under that
-- restaurant's URL gets a human verdict.
CREATE TABLE IF NOT EXISTS eval_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url TEXT NOT NULL,
  name TEXT,
  city TEXT,
  missed_menus TEXT, -- free text: real menus on the site the pipeline never found
  notes TEXT,
  menus_reviewed_at TIMESTAMPTZ, -- set when a human confirms this restaurant's menu discovery is correct (menu-level review)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_cases_url_unique ON eval_cases (lower(url));

CREATE TABLE IF NOT EXISTS eval_menu_candidates ( -- discovery-review verdicts
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  eval_case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct', 'spurious', 'duplicate')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eval_dishes ( -- auto-grown, human-validated ground truth
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  eval_case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  menu_label TEXT,
  section_name TEXT,
  name TEXT NOT NULL,
  expected_classification TEXT NOT NULL CHECK (expected_classification IN ('vegan','vegetarian','neither','unknown')),
  -- What the AI originally guessed at the moment a human gave a verdict, captured
  -- BEFORE the live dish is overwritten. accuracy = % where it == expected_classification.
  ai_original_classification TEXT CHECK (ai_original_classification IN ('vegan','vegetarian','neither','unknown')),
  source TEXT NOT NULL DEFAULT 'admin_review' CHECK (source IN ('admin_review','feedback_confirmed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_dishes_case_name_unique ON eval_dishes (eval_case_id, lower(name));

-- Live-correction support: preserves human fixes/adds/removals across reparses.
ALTER TABLE dishes
  ADD COLUMN IF NOT EXISTS human_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reviewer_notes TEXT;

-- Feedback triage verdicts.
ALTER TABLE dish_reports
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE restaurant_feedback
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ============================================================
-- Unique constraints
-- ============================================================

-- One row per URL (case-insensitive via unique index)
CREATE UNIQUE INDEX IF NOT EXISTS restaurants_url_unique ON restaurants (lower(url));

-- A restaurant can only be featured once per city
CREATE UNIQUE INDEX IF NOT EXISTS featured_restaurant_city_unique
  ON featured_restaurants (restaurant_id, city);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status);
CREATE INDEX IF NOT EXISTS idx_restaurants_city ON restaurants(city);
CREATE INDEX IF NOT EXISTS idx_dishes_restaurant ON dishes(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_dishes_section ON dishes(section_id);
CREATE INDEX IF NOT EXISTS idx_dish_reports_dish ON dish_reports(dish_id);
CREATE INDEX IF NOT EXISTS idx_featured_city ON featured_restaurants(city, display_order);
CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_time ON rate_limit_events(ip_hash, created_at);

-- ============================================================
-- Auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER restaurants_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER dishes_updated_at
  BEFORE UPDATE ON dishes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Clean up old rate limit events (older than 2 hours)
-- ============================================================
-- Run as a Supabase cron job or edge function:
-- DELETE FROM rate_limit_events WHERE created_at < NOW() - INTERVAL '2 hours';
