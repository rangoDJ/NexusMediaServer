-- Track active session load per transcoder node for routing decisions
ALTER TABLE transcoder_nodes ADD COLUMN active_sessions INT NOT NULL DEFAULT 0;
ALTER TABLE transcoder_nodes ADD COLUMN registered_at TIMESTAMPTZ;
