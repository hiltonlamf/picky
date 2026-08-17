-- A restaurant brand can have several branches. Keep each first-party address
-- independently so detail pages can show every branch and guide filters can
-- match a restaurant when any of its branches is in the selected area.
CREATE TABLE IF NOT EXISTS public.restaurant_locations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id         UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  label                 TEXT,
  address               TEXT NOT NULL,
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  neighbourhood_id      UUID REFERENCES public.city_neighbourhoods(id) ON DELETE SET NULL,
  area_code             TEXT,
  area_label            TEXT,
  area_source           TEXT CHECK (area_source IN ('eircode_prefix', 'manual', 'geocoder')),
  location_source       TEXT CHECK (location_source IN ('website_jsonld', 'website_address_element', 'website_map_link', 'website_contact_page')),
  location_source_url   TEXT,
  location_confidence   TEXT CHECK (location_confidence IN ('high', 'medium', 'low')),
  location_checked_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_locations_restaurant_address_unique
  ON public.restaurant_locations (restaurant_id, lower(address));
CREATE INDEX IF NOT EXISTS restaurant_locations_restaurant_idx
  ON public.restaurant_locations (restaurant_id);
CREATE INDEX IF NOT EXISTS restaurant_locations_area_idx
  ON public.restaurant_locations (area_label)
  WHERE area_label IS NOT NULL;

-- Preserve every address already backfilled into the former single-address
-- model. The old columns intentionally remain as a compatibility summary.
INSERT INTO public.restaurant_locations (
  restaurant_id, address, latitude, longitude, neighbourhood_id,
  area_code, area_label, area_source, location_source, location_source_url,
  location_confidence, location_checked_at
)
SELECT
  id, address, latitude, longitude, neighbourhood_id,
  area_code, area_label, area_source, location_source, location_source_url,
  location_confidence, location_checked_at
FROM public.restaurants
WHERE address IS NOT NULL AND btrim(address) <> ''
ON CONFLICT DO NOTHING;

ALTER TABLE public.restaurant_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.restaurant_locations FROM anon, authenticated;

DROP TRIGGER IF EXISTS restaurant_locations_updated_at ON public.restaurant_locations;
CREATE TRIGGER restaurant_locations_updated_at
  BEFORE UPDATE ON public.restaurant_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
