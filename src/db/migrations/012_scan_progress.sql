-- Ephemeral scan progress columns on libraries.
-- Updated in-flight during a scan so that REST polling clients also see progress.
ALTER TABLE libraries
  ADD COLUMN IF NOT EXISTS scan_progress INT     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scan_phase    TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scan_current  TEXT    DEFAULT NULL;
