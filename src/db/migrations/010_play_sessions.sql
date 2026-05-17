-- Unified playback log covering both direct-play and transcoded sessions.
-- Lets us show the direct/transcode ratio and per-user watch history without
-- relying on transcode_sessions (which only records transcoded streams).
CREATE TABLE play_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Exactly one of these is set:
  media_item_id        UUID REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id           UUID REFERENCES episodes(id) ON DELETE CASCADE,
  play_type            TEXT NOT NULL DEFAULT 'transcode', -- 'direct' | 'transcode'
  -- Set for transcode sessions so we can cross-reference codec/resolution data
  transcode_session_id UUID REFERENCES transcode_sessions(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Populated when the client calls DELETE /stream/:id or GET /direct with Range=0
  -- on a subsequent session. NULL means still playing or client didn't report end.
  ended_at             TIMESTAMPTZ
);

CREATE INDEX play_sessions_user_idx    ON play_sessions(user_id);
CREATE INDEX play_sessions_started_idx ON play_sessions(started_at DESC);
CREATE INDEX play_sessions_type_idx    ON play_sessions(play_type, started_at DESC);
