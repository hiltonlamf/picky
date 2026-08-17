-- Broad, reliable guide areas. Dublin uses Eircode routing keys rather than
-- pretending that a postal district is a precise neighbourhood polygon.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS area_code TEXT,
  ADD COLUMN IF NOT EXISTS area_label TEXT,
  ADD COLUMN IF NOT EXISTS area_source TEXT
    CHECK (area_source IN ('eircode_prefix', 'manual', 'geocoder'));

CREATE INDEX IF NOT EXISTS restaurants_city_area_label_idx
  ON restaurants (lower(city), area_label)
  WHERE area_label IS NOT NULL;
