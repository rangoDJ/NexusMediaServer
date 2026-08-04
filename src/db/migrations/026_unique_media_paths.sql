-- 026_unique_media_paths.sql
-- Give media_items.file_path and episodes.file_path a UNIQUE index so the
-- scan-time `INSERT ... ON CONFLICT DO NOTHING` (which lists no conflict
-- target) is actually effective. Without a matching unique/pk constraint,
-- Postgres treats ON CONFLICT DO NOTHING as a no-op, so a concurrent re-scan
-- could insert duplicate rows for the same file.
--
-- file_path is nullable (series rows), and Postgres treats a UNIQUE index on a
-- nullable column leniently (multiple NULLs allowed), so this never rejects
-- series rows that have no file path.

-- Deduplicate media_items.file_path, keeping the lowest id. All FK references
-- are ON DELETE CASCADE, so surplus child rows (progress/sessions/segments)
-- are cleaned up automatically. Series rows have NULL file_path and are
-- unaffected.
DELETE FROM media_items m
USING media_items m2
WHERE m.id > m2.id
  AND m.file_path IS NOT NULL
  AND m.file_path = m2.file_path;

-- Deduplicate episodes.file_path, keeping the lowest id.
DELETE FROM episodes e
USING episodes e2
WHERE e.id > e2.id
  AND e.file_path IS NOT NULL
  AND e.file_path = e2.file_path;

CREATE UNIQUE INDEX IF NOT EXISTS media_items_file_path_uq ON media_items(file_path);
CREATE UNIQUE INDEX IF NOT EXISTS episodes_file_path_uq ON episodes(file_path);