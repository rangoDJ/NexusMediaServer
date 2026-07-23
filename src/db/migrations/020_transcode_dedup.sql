-- start_time_secs is needed as a match key so /stream/start can dedup identical
-- concurrent requests (same media + params) onto one remote ffmpeg process
-- instead of spawning a second one for every reload/duplicate tab.
ALTER TABLE transcode_sessions ADD COLUMN IF NOT EXISTS start_time_secs INT NOT NULL DEFAULT 0;

-- Whether the session is an ABR (multi-variant) HLS stream. Persisted so that
-- when /stream/start dedups onto an existing session, it can tell the client
-- to fetch master.m3u8 vs playlist.m3u8 without re-asking the transcoder node.
ALTER TABLE transcode_sessions ADD COLUMN IF NOT EXISTS is_abr BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_transcode_sessions_active_match
  ON transcode_sessions (media_item_id, episode_id, codec, resolution, bitrate, start_time_secs)
  WHERE status = 'active';

-- Per-node concurrent session cap. NULL = unlimited (today's behavior).
ALTER TABLE transcoder_nodes ADD COLUMN IF NOT EXISTS max_sessions INT;
