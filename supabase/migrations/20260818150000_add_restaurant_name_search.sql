CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS restaurants_name_trgm_idx
  ON public.restaurants USING gin (name gin_trgm_ops)
  WHERE name IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.restaurant_place_links (
  provider          TEXT NOT NULL CHECK (provider IN ('google')),
  provider_place_id TEXT NOT NULL,
  restaurant_id     UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_place_id)
);

CREATE INDEX IF NOT EXISTS restaurant_place_links_restaurant_idx
  ON public.restaurant_place_links (restaurant_id);

CREATE TABLE IF NOT EXISTS public.external_lookup_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ip_hash    TEXT NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{16}$|^[0-9a-f]{64}$'),
  kind       TEXT NOT NULL CHECK (kind IN ('autocomplete', 'details')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS external_lookup_events_ip_kind_time_idx
  ON public.external_lookup_events (ip_hash, kind, created_at DESC);

ALTER TABLE public.restaurant_place_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_lookup_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.restaurant_place_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.external_lookup_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.restaurant_place_links TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.external_lookup_events TO service_role;
