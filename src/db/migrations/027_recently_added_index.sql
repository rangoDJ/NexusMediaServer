-- 027_recently_added_index.sql
-- The dashboard's "Latest [Library]" rows and GET /media?sort=recently_added
-- filter by library_id and sort by created_at DESC. The existing
-- media_items_library_idx only covers library_id, so Postgres filters by
-- library then sorts the matches in memory on every call. This composite
-- index lets it satisfy both the filter and the ORDER BY directly.
CREATE INDEX IF NOT EXISTS media_items_library_created_idx ON media_items(library_id, created_at DESC);
