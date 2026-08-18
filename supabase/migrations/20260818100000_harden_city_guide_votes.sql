-- Defense in depth for the public city-vote endpoint. The API writes with the
-- service role; browsers and signed-in users never need direct table access.
REVOKE ALL ON TABLE public.city_guide_votes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.city_guide_votes TO service_role;

ALTER TABLE public.city_guide_votes
  ADD CONSTRAINT city_guide_votes_email_shape
    CHECK (
      char_length(email) BETWEEN 3 AND 254
      AND email = lower(email)
      AND email = btrim(email)
    ) NOT VALID,
  ADD CONSTRAINT city_guide_votes_ip_hash_shape
    CHECK (ip_hash ~ '^[0-9a-f]{16}$|^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT city_guide_votes_anon_id_length
    CHECK (anon_id IS NULL OR char_length(anon_id) <= 64) NOT VALID;

ALTER TABLE public.city_guide_votes VALIDATE CONSTRAINT city_guide_votes_email_shape;
ALTER TABLE public.city_guide_votes VALIDATE CONSTRAINT city_guide_votes_ip_hash_shape;
ALTER TABLE public.city_guide_votes VALIDATE CONSTRAINT city_guide_votes_anon_id_length;

-- Serialize inserts per private IP key so a burst of concurrent requests
-- cannot race past the application-level ten-votes-per-day check.
CREATE OR REPLACE FUNCTION public.enforce_city_guide_vote_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.ip_hash, 0));

  -- Let the unique email/city index handle an idempotent re-submission without
  -- charging it against the abuse budget.
  IF EXISTS (
    SELECT 1
    FROM public.city_guide_votes
    WHERE lower(email) = lower(NEW.email)
      AND lower(city_name) = lower(NEW.city_name)
      AND lower(COALESCE(country_name, '')) = lower(COALESCE(NEW.country_name, ''))
  ) THEN
    RETURN NEW;
  END IF;

  IF (
    SELECT count(*)
    FROM public.city_guide_votes
    WHERE ip_hash = NEW.ip_hash
      AND created_at >= NOW() - INTERVAL '24 hours'
  ) >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'city_vote_rate_limited';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_city_guide_vote_rate_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_city_guide_vote_rate_limit() TO service_role;

DROP TRIGGER IF EXISTS enforce_city_guide_vote_rate_limit ON public.city_guide_votes;
CREATE TRIGGER enforce_city_guide_vote_rate_limit
  BEFORE INSERT ON public.city_guide_votes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_city_guide_vote_rate_limit();
