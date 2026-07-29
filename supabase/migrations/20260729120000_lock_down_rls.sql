-- Lock down public-schema access: RLS on every table, no anon/authenticated reach.
--
-- Context: Supabase flagged `rls_disabled_in_public` (critical) on 2026-07-26.
-- Four tables had Row-Level Security switched off — eval_cases, eval_dishes,
-- eval_menu_candidates and restaurant_feedback — while Supabase's stock grants
-- gave the `anon` role (the key embedded in any public site) full
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE on them. Anyone with the project URL and
-- the anon key could have read or wiped user feedback (free-text notes, ip_hash,
-- anon_id) and the whole evaluation ground-truth set.
--
-- Security model for this app: the browser NEVER talks to Supabase directly.
-- Every read and write goes through Next.js server code using
-- SUPABASE_SERVICE_ROLE_KEY (see lib/db.ts, lib/rate-limit.ts,
-- lib/init-dublin.ts, app/api/admin/login). The service role has BYPASSRLS, so
-- the app, admin routes and maintenance scripts are unaffected by anything here.
--
-- Therefore the correct policy set is EMPTY. RLS enabled + zero policies = deny
-- all to anon/authenticated. Adding a policy would *open* access, not secure it.
-- Supabase's linter reports "RLS enabled, no policy" as an INFO notice on these
-- tables; that is intentional, not an oversight.

-- ============================================================
-- 1. Enable RLS on the tables that were missing it
-- ============================================================
ALTER TABLE public.eval_cases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_dishes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_menu_candidates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_feedback   ENABLE ROW LEVEL SECURITY;

-- Re-assert on the rest so this migration is the single source of truth.
ALTER TABLE public.restaurants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_sections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dishes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dish_reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.featured_restaurants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.city_guides           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parse_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nps_responses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_events     ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. Remove the one leftover permissive policy
-- ============================================================
-- `city_guides` carried "Allow public read" (anon, SELECT, USING true) from
-- before the guides were served through server routes. Nothing reads
-- city_guides from the browser any more (lib/db.ts:991+ uses the service role),
-- and `USING true` ignored the `status` column — so unpublished DRAFT guides
-- were readable by anyone with the anon key. Dropping it closes that.
DROP POLICY IF EXISTS "Allow public read" ON public.city_guides;

-- ============================================================
-- 3. Second layer: take away the grants themselves
-- ============================================================
-- RLS is the gate, but the stock grants mean a single accidental
-- "disable RLS" click re-exposes a table completely (exactly what happened
-- here). Revoking the underlying privileges means anon/authenticated have no
-- reach even if RLS is later switched off on a table by mistake.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- And stop future tables from inheriting the stock grants, so a new table is
-- born locked rather than open. (Applies to objects created by `postgres`,
-- which is the role our migrations and the SQL editor run as.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Note: service_role keeps its grants and its BYPASSRLS attribute untouched,
-- which is what the app, the admin pages and scripts/ all use.
