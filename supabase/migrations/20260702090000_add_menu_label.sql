-- Per-menu grouping: which source menu (Lunch/Dinner/Weekend...) a section
-- belongs to, so the results page can present one menu at a time.
-- NULL for single-menu restaurants.
alter table menu_sections
  add column if not exists menu_label text;
