-- Permanent, readable restaurant URLs: /restaurant/<city>/<slug>.
-- Slugs are assigned once. Later restaurants with the same name receive -2,
-- -3, etc., so adding a duplicate never changes an existing public URL.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS slug TEXT;

WITH bases AS (
  SELECT
    id,
    city,
    created_at,
    EXISTS (
      SELECT 1
      FROM public.featured_restaurants AS featured
      WHERE featured.restaurant_id = restaurants.id
        AND lower(featured.city) = lower(restaurants.city)
        AND featured.hidden = false
    ) AS featured_in_public_city,
    COALESCE(
      NULLIF(
        trim(BOTH '-' FROM regexp_replace(
          translate(
            lower(COALESCE(name, 'restaurant')),
            'àáâãäåçèéêëìíîïñòóôõöùúûüýÿž',
            'aaaaaaceeeeiiiinooooouuuuyyz'
          ),
          '[^a-z0-9]+', '-', 'g'
        )),
        ''
      ),
      'restaurant'
    ) AS base_slug
  FROM public.restaurants
  WHERE slug IS NULL
), ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (
      PARTITION BY lower(city), base_slug
      ORDER BY featured_in_public_city DESC, created_at, id
    ) AS duplicate_number
  FROM bases
)
UPDATE public.restaurants AS restaurant
SET slug = CASE
  WHEN ranked.duplicate_number = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || ranked.duplicate_number::text
END
FROM ranked
WHERE restaurant.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_city_slug_unique
  ON public.restaurants (lower(city), slug)
  WHERE slug IS NOT NULL;

ALTER TABLE public.restaurants
  ADD CONSTRAINT restaurants_slug_format
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;

ALTER TABLE public.restaurants VALIDATE CONSTRAINT restaurants_slug_format;

-- Existing table grants/RLS remain unchanged: browsers still cannot read or
-- write restaurant rows directly; all access stays behind the server.
