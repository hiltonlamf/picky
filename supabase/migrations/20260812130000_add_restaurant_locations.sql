-- First-party restaurant addresses and OSM-derived neighbourhood geometry.
-- No public browser talks to these tables: the server uses service_role only.

CREATE TABLE IF NOT EXISTS city_neighbourhoods (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  city           TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  -- Optional future human-friendly grouping (e.g. several OSM areas under one
  -- guide-facing label). NULL means display_name is shown and filtered.
  group_name     TEXT,
  geometry       JSONB NOT NULL,
  source         TEXT NOT NULL DEFAULT 'openstreetmap'
                   CHECK (source IN ('openstreetmap', 'manual')),
  source_url     TEXT,
  source_license TEXT NOT NULL DEFAULT 'Open Data Commons Open Database License (ODbL) v1.0',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS city_neighbourhoods_city_name_unique
  ON city_neighbourhoods (lower(city), lower(display_name));
CREATE INDEX IF NOT EXISTS city_neighbourhoods_city_active_idx
  ON city_neighbourhoods (lower(city)) WHERE active;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS neighbourhood_id UUID REFERENCES city_neighbourhoods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_source TEXT
    CHECK (location_source IN ('website_jsonld', 'website_address_element', 'website_map_link', 'website_contact_page')),
  ADD COLUMN IF NOT EXISTS location_source_url TEXT,
  ADD COLUMN IF NOT EXISTS location_confidence TEXT
    CHECK (location_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS location_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS restaurants_city_neighbourhood_idx ON restaurants (lower(city), neighbourhood_id);
CREATE INDEX IF NOT EXISTS restaurants_location_backfill_idx
  ON restaurants (lower(city), created_at) WHERE address IS NULL;

ALTER TABLE public.city_neighbourhoods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.city_neighbourhoods FROM anon, authenticated;

CREATE TRIGGER city_neighbourhoods_updated_at
  BEFORE UPDATE ON city_neighbourhoods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
