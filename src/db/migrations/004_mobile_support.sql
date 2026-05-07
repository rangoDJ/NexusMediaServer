-- Refresh tokens for mobile clients (short-lived access + long-lived refresh)
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_name TEXT,
  device_type TEXT,        -- 'ios' | 'android' | 'web' | 'other'
  ip_address  TEXT,
  user_agent  TEXT,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);

-- File-level technical metadata (populated by scanner via ffprobe)
ALTER TABLE media_items
  ADD COLUMN duration_secs  INT,
  ADD COLUMN video_codec    TEXT,
  ADD COLUMN audio_codec    TEXT,
  ADD COLUMN container      TEXT,
  ADD COLUMN file_size      BIGINT,
  ADD COLUMN width          INT,
  ADD COLUMN height         INT,
  ADD COLUMN bitrate_kbps   INT;

ALTER TABLE episodes
  ADD COLUMN duration_secs  INT,
  ADD COLUMN video_codec    TEXT,
  ADD COLUMN audio_codec    TEXT,
  ADD COLUMN container      TEXT,
  ADD COLUMN file_size      BIGINT,
  ADD COLUMN width          INT,
  ADD COLUMN height         INT,
  ADD COLUMN bitrate_kbps   INT;
