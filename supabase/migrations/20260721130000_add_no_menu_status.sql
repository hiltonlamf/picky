-- Adds a distinct "no menu / dead site" terminal outcome, separate from a
-- generic error. Group-B restaurants (the site has no readable menu, or is
-- down/closed) get status='no_menu' instead of 'error', so that:
--   * the results page can show a friendly, actionable screen rather than a
--     red "Couldn't read this menu" error;
--   * the discover route stops re-running the PAID pipeline on every future
--     search of a menu-less site (today an 'error' restaurant is re-analyzed
--     on the next search — a real, guide-wide cost leak);
--   * an admin can CONFIRM the outcome (no_menu_confirmed_at) so it sticks
--     permanently, past the 30-day staleness window.
-- no_menu_reason drives the user-facing copy:
--   'not_listed'  — the site is up but publishes no readable menu
--   'unavailable' — the site is down / not live yet (definitive fetch failure)
--   'closed'      — admin-set: the restaurant is permanently closed
--
-- Renamed from 20260721120000 to 20260721130000 — that earlier timestamp was
-- independently reused by 20260721120000_add_feedback_city.sql on a
-- concurrent branch; both migrations' DDL already landed on prod (idempotent
-- IF NOT EXISTS), this file rename just fixes the on-disk collision.

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_status_check;
ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_status_check
  CHECK (status IN ('pending', 'processing', 'done', 'error', 'no_menu'));

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS no_menu_reason       TEXT,
  ADD COLUMN IF NOT EXISTS no_menu_confirmed_at TIMESTAMPTZ;
