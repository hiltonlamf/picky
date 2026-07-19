-- Dish provenance + soft-delete: keep a record of what the AI created vs what a
-- human changed, and never permanently destroy a dish — mark it deleted instead,
-- so we can troubleshoot "what happened" later.
--   origin              — who created this row: the AI pipeline or an admin by hand.
--   ai_classification   — what the AI originally classified it as, kept even after
--                         a human overwrites `classification`, so "AI said X → now Y"
--                         is always visible.
--   deleted_at          — soft delete. Non-null = removed by admin; excluded from
--                         everything users see, but the record survives (and a
--                         reparse won't resurrect it).
ALTER TABLE dishes
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai', 'admin')),
  ADD COLUMN IF NOT EXISTS ai_classification TEXT CHECK (ai_classification IN ('vegan', 'vegetarian', 'neither', 'unknown')),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Backfill the AI's original classification for existing pure-AI rows (a
-- human-verified row may already have been overwritten, so we can't recover its
-- original — leave those null = unknown original).
UPDATE dishes SET ai_classification = classification WHERE ai_classification IS NULL AND human_verified = FALSE;
