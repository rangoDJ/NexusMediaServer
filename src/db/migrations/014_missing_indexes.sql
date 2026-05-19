-- Indexes missing from the initial schema that cause full sequential scans
-- on the most frequently executed queries.
--
-- media_items(file_path)
--   Hit by scanner.js on every video file during a movie scan to check whether
--   the file already exists. Without this, every scan does a full table scan of
--   media_items — even for a library with a single new file.
CREATE INDEX IF NOT EXISTS media_items_file_path_idx ON media_items(file_path);

-- episodes(file_path)
--   Same pattern: the per-episode duplicate check in scanner.js previously ran
--   one unindexed SELECT per video file. A 100-episode show fired 100 sequential
--   full scans of the episodes table.
CREATE INDEX IF NOT EXISTS episodes_file_path_idx ON episodes(file_path);

-- transcode_sessions(status)
--   The health-poller reconciliation (UPDATE … WHERE status='active') and the
--   admin stream-stats endpoint (WHERE status IN ('done','error')) both filter
--   on this column. At thousands of historical sessions it becomes a full scan.
CREATE INDEX IF NOT EXISTS transcode_sessions_status_idx ON transcode_sessions(status);

-- play_sessions(user_id, started_at DESC)
--   The admin stream-stats top-users query groups by user_id and filters by
--   started_at. A composite index satisfies both predicates in one scan.
CREATE INDEX IF NOT EXISTS play_sessions_user_started_idx ON play_sessions(user_id, started_at DESC);

-- media_items(library_id, type)
--   The scanner's series-lookup queries filter on both library_id AND type='series'.
--   The existing media_items_library_idx covers library_id alone; adding type makes
--   the compound predicate index-only in most cases.
CREATE INDEX IF NOT EXISTS media_items_library_type_idx ON media_items(library_id, type);
