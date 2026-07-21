-- Guide-level feedback: users can suggest a restaurant to add to a city guide, or
-- flag an issue with a listed one — feedback that isn't tied to one restaurant.
-- `city` records which guide it's about (restaurant_id stays NULL for these).
ALTER TABLE restaurant_feedback
  ADD COLUMN IF NOT EXISTS city TEXT;
