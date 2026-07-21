-- Per-restaurant cuisine label (Italian / Indian / Chinese / Modern European / ...).
-- Emitted by the extraction prompt (lib/ai.ts SYSTEM_PROMPT) for all future
-- restaurants; backfilled for existing rows by scripts/backfill-cuisine.ts.
-- Shown on guide cards so diners can see the cuisine at a glance.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS cuisine TEXT;
