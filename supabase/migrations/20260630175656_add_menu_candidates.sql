-- Multi-menu disambiguation: hold the discovered candidate menus between the
-- discover and analyze phases (the analyze step references these by id only).
alter table restaurants
  add column if not exists menu_candidates jsonb,
  add column if not exists candidates_at   timestamptz;
