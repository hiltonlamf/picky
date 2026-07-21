-- Restaurant de-duplication key + public-guide review gate.
--
--   dedup_key         — the identity key used to collapse duplicate restaurants.
--                       For a dedicated restaurant domain it is the bare root
--                       host (so `dohertysbar.ie/menu/`, `https://dohertysbar.ie`
--                       and `www.dohertysbar.ie` are ONE restaurant); for shared
--                       platforms (Toast/Square/Maps/social/review sites) it is
--                       the full normalized path, so distinct restaurants on one
--                       host stay distinct. Computed in app code (lib/db.ts
--                       restaurantDedupKey) and backfilled by
--                       scripts/dedupe-restaurants.ts.
--   guide_approved_at — set when an admin approves an odd-but-featured restaurant
--                       (e.g. a tasting menu captured as a single "dish") for
--                       public display. NULL = a flagged restaurant stays hidden
--                       from the public guide until reviewed.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS dedup_key         TEXT,
  ADD COLUMN IF NOT EXISTS guide_approved_at TIMESTAMPTZ;

-- One restaurant per dedup key — the durable, write-time guard against future
-- subpage/www/scheme duplicates. Partial (WHERE dedup_key IS NOT NULL) so legacy
-- rows left un-keyed don't collide. This index must be created only AFTER
-- scripts/dedupe-restaurants.ts has backfilled keys and resolved existing
-- duplicates, otherwise the build fails on the current dohertysbar.ie pair.
CREATE UNIQUE INDEX IF NOT EXISTS restaurants_dedup_key_unique
  ON restaurants (dedup_key) WHERE dedup_key IS NOT NULL;
