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
  ADD COLUMN IF NOT EXISTS duration_secs  INT,
  ADD COLUMN IF NOT EXISTS video_codec    TEXT,
  ADD COLUMN IF NOT EXISTS audio_codec    TEXT,
  ADD COLUMN IF NOT EXISTS container      TEXT,
  ADD COLUMN IF NOT EXISTS file_size      BIGINT,
  ADD COLUMN IF NOT EXISTS width          INT,
  ADD COLUMN IF NOT EXISTS height         INT,
  ADD COLUMN IF NOT EXISTS bitrate_kbps   INT;

-- duration_secs already exists on episodes from 001_initial.sql;
-- IF NOT EXISTS makes all additions safe to re-run.
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS duration_secs  INT,
  ADD COLUMN IF NOT EXISTS video_codec    TEXT,
  ADD COLUMN IF NOT EXISTS audio_codec    TEXT,
  ADD COLUMN IF NOT EXISTS container      TEXT,
  ADD COLUMN IF NOT EXISTS file_size      BIGINT,
  ADD COLUMN IF NOT EXISTS width          INT,
  ADD COLUMN IF NOT EXISTS height         INT,
  ADD COLUMN IF NOT EXISTS bitrate_kbps   INT;
