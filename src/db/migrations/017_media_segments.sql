-- Media segments: time-coded intro / credits / recap windows per episode.
-- Populated by the analyze-intros background task (Chromaprint fingerprinting).
CREATE TABLE IF NOT EXISTS media_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('intro', 'credits', 'recap')),
  start_secs  REAL NOT NULL,
  end_secs    REAL NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, type)
);
CREATE INDEX IF NOT EXISTS media_segments_episode_idx ON media_segments(episode_id);
