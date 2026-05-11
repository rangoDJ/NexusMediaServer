-- Dedicated cast/people index for large libraries (20k+ items).
-- Previously search and filmography lookups full-scanned every row's
-- metadata->'cast' JSONB array. This table is kept in sync by a trigger
-- on media_items so callers don't have to think about it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS media_cast (
  id            BIGSERIAL PRIMARY KEY,
  media_item_id UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  person_id     TEXT NOT NULL,            -- TMDB person id (as text)
  name          TEXT NOT NULL,
  character     TEXT,
  profile_url   TEXT,
  UNIQUE (media_item_id, person_id)
);

-- Filmography lookup: WHERE person_id = $1
CREATE INDEX IF NOT EXISTS media_cast_person_idx ON media_cast(person_id);

-- Cascade delete + reverse lookup
CREATE INDEX IF NOT EXISTS media_cast_media_idx  ON media_cast(media_item_id);

-- Trigram ILIKE search on name: WHERE name ILIKE '%foo%'
CREATE INDEX IF NOT EXISTS media_cast_name_trgm
  ON media_cast USING GIN (name gin_trgm_ops);

-- Sync function: rebuild this item's cast rows from its current metadata.
CREATE OR REPLACE FUNCTION sync_media_cast() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM media_cast WHERE media_item_id = NEW.id;

  IF NEW.metadata ? 'cast' THEN
    INSERT INTO media_cast (media_item_id, person_id, name, character, profile_url)
    SELECT
      NEW.id,
      c->>'id',
      c->>'name',
      c->>'character',
      c->>'profile_url'
    FROM jsonb_array_elements(NEW.metadata->'cast') AS c
    WHERE c->>'id'   IS NOT NULL
      AND c->>'name' IS NOT NULL
    ON CONFLICT (media_item_id, person_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fire on INSERT and on UPDATE-of-metadata only (other column changes are skipped)
DROP TRIGGER IF EXISTS media_items_cast_sync ON media_items;
CREATE TRIGGER media_items_cast_sync
AFTER INSERT OR UPDATE OF metadata ON media_items
FOR EACH ROW EXECUTE FUNCTION sync_media_cast();

-- Backfill from existing items (one-time, idempotent via ON CONFLICT)
INSERT INTO media_cast (media_item_id, person_id, name, character, profile_url)
SELECT
  m.id,
  c->>'id',
  c->>'name',
  c->>'character',
  c->>'profile_url'
FROM media_items m,
     jsonb_array_elements(m.metadata->'cast') AS c
WHERE c->>'id'   IS NOT NULL
  AND c->>'name' IS NOT NULL
ON CONFLICT (media_item_id, person_id) DO NOTHING;
