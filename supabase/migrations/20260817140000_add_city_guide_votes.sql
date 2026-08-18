-- Votes for the next city guide. The browser never accesses this table: the
-- public form posts to a Next.js route, which writes with the service role.
-- Email is retained so votes can be deduplicated and the voter can be told when
-- their city gets a guide.

CREATE TABLE IF NOT EXISTS public.city_guide_votes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_name    TEXT NOT NULL CHECK (char_length(city_name) BETWEEN 2 AND 120),
  country_name TEXT,
  region       TEXT NOT NULL CHECK (region IN ('Europe', 'Asia', 'USA', 'Australia')),
  is_custom    BOOLEAN NOT NULL DEFAULT FALSE,
  email        TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  anon_id      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((is_custom AND country_name IS NULL)
    OR (NOT is_custom AND country_name IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_city_guide_votes_email_city
  ON public.city_guide_votes (lower(email), lower(city_name), lower(COALESCE(country_name, '')));
CREATE INDEX IF NOT EXISTS idx_city_guide_votes_created_at
  ON public.city_guide_votes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_city_guide_votes_ip_created_at
  ON public.city_guide_votes (ip_hash, created_at DESC);

ALTER TABLE public.city_guide_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.city_guide_votes FROM anon, authenticated;

COMMENT ON TABLE public.city_guide_votes IS
  'Email-attributed requests for the next public city guide; service-role access only.';
