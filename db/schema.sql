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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Multi-menu disambiguation: discovered candidate menus held between the
-- discover and analyze phases (the analyze step references these by id only).
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS menu_candidates JSONB,
  ADD COLUMN IF NOT EXISTS candidates_at   TIMESTAMPTZ;

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
