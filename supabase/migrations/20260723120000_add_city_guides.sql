-- City guides: a first-class, admin-managed home for the draft → published
-- lifecycle of a city guide. Before this, a "city guide" was emergent (a
-- restaurants.city string + featured_restaurants rows) with no way to build one
-- privately and publish it deliberately.

CREATE TABLE IF NOT EXISTS city_guides (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug          TEXT NOT NULL UNIQUE,        -- URL segment, e.g. 'amsterdam'
  display_name  TEXT NOT NULL,               -- 'Amsterdam'
  country       TEXT,                        -- 'Netherlands' (copy + language context)
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  tagline       TEXT,                        -- optional hero override
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill Dublin as an already-published, editable guide so it appears in the
-- new admin workspace alongside future cities.
INSERT INTO city_guides (slug, display_name, country, status, published_at)
VALUES ('dublin', 'Dublin', 'Ireland', 'published', NOW())
ON CONFLICT (slug) DO NOTHING;

-- Persist the AI-detected menu language (previously computed then discarded).
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_language TEXT;

-- Manual "hide from public" per guide membership. Lets an admin keep a
-- restaurant in the guide workspace (to keep debugging it) while suppressing it
-- from the public page, independent of the automatic quality gate.
ALTER TABLE featured_restaurants ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
