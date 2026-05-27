-- Movie collections sourced from TMDB belongs_to_collection.
CREATE TABLE IF NOT EXISTS collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id     TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  overview    TEXT,
  poster_url  TEXT,
  backdrop_url TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS media_items_collection_idx ON media_items(collection_id)
  WHERE collection_id IS NOT NULL;
