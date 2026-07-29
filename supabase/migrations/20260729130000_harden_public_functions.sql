-- Harden public-schema functions (follow-up to 20260729120000_lock_down_rls).
--
-- Supabase's security advisor flagged three things after the RLS lockdown:
--
--   1. `rls_auto_enable()` executable by anon/authenticated as SECURITY DEFINER.
--      Low real risk: it RETURNS event_trigger, so PostgREST cannot invoke it
--      and pg_event_trigger_ddl_commands() errors outside a DDL event. It is a
--      useful safety net (auto-enables RLS on any newly created public table),
--      so it stays — we just stop advertising it over RPC.
--
--   2. `prune_parse_attempts(retain_days int)` executable by PUBLIC. This was a
--      genuine hole: it is SECURITY INVOKER and does an unconditional DELETE, so
--      before the grant revocation anyone with the anon key could have called
--      POST /rest/v1/rpc/prune_parse_attempts with retain_days=0 and wiped the
--      whole parse_attempts history. Already blocked by the table-grant revoke
--      (invoker rights), but closing it at the function level too.
--
--   3. Mutable search_path on the two non-DEFINER functions — pin it so a role
--      with a custom search_path cannot shadow the objects they reference.
--
-- Why REVOKE FROM PUBLIC and not just anon/authenticated: PostgreSQL grants
-- EXECUTE on new functions to PUBLIC by default, and anon/authenticated inherit
-- that. Revoking from the two named roles alone leaves the PUBLIC grant in
-- place, which is exactly how these stayed reachable.

-- ============================================================
-- 1. Stop PUBLIC (and therefore anon/authenticated) executing anything
-- ============================================================
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- postgres and service_role keep their explicit EXECUTE grants, so the app,
-- scripts/prune-parse-attempts.ts and the updated_at triggers are unaffected.
-- (Trigger functions are privilege-checked when the trigger is created, not on
-- each fire, so the updated_at triggers keep working regardless.)

-- ============================================================
-- 2. Pin search_path on the functions that lacked it
-- ============================================================
ALTER FUNCTION public.update_updated_at()                  SET search_path = pg_catalog, public;
ALTER FUNCTION public.prune_parse_attempts(integer)         SET search_path = pg_catalog, public;
