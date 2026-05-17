-- Track when a transcode session ended so we can show duration in the stats dashboard.
ALTER TABLE transcode_sessions
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
