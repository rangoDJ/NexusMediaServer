-- Users & auth
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer', -- 'admin' | 'viewer'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Libraries (a root folder + media type)
CREATE TABLE libraries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL, -- 'movies' | 'tv' | 'music'
  paths       TEXT[] NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'scanning' | 'error'
  last_scanned_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Media items (movies, series, albums)
CREATE TABLE media_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id  UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- 'movie' | 'series' | 'music_album'
  title       TEXT NOT NULL,
  sort_title  TEXT,
  year        INT,
  tmdb_id     TEXT,
  imdb_id     TEXT,
  plot        TEXT,
  tagline     TEXT,
  genres      TEXT[],
  poster_url  TEXT,
  backdrop_url TEXT,
  rating      NUMERIC(3,1),
  file_path   TEXT, -- NULL for series (episodes have paths)
  nfo_path    TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_items_library_idx ON media_items(library_id);
CREATE INDEX media_items_tmdb_idx ON media_items(tmdb_id);

-- TV episodes
CREATE TABLE episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id       UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season_number   INT NOT NULL,
  episode_number  INT NOT NULL,
  title           TEXT,
  plot            TEXT,
  air_date        DATE,
  file_path       TEXT NOT NULL,
  nfo_path        TEXT,
  duration_secs   INT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX episodes_series_idx ON episodes(series_id);

-- Watch progress per user
CREATE TABLE watch_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of these is set:
  media_item_id UUID REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id    UUID REFERENCES episodes(id) ON DELETE CASCADE,
  position_secs INT NOT NULL DEFAULT 0,
  duration_secs INT,
  completed     BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, media_item_id),
  UNIQUE (user_id, episode_id)
);

-- Registered transcoder nodes
CREATE TABLE transcoder_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  url         TEXT NOT NULL UNIQUE, -- e.g. http://transcoder-1:3001
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active transcode sessions
CREATE TABLE transcode_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_item_id   UUID REFERENCES media_items(id) ON DELETE CASCADE,
  episode_id      UUID REFERENCES episodes(id) ON DELETE CASCADE,
  transcoder_node_id UUID REFERENCES transcoder_nodes(id),
  remote_session_id TEXT, -- session ID on the transcoder node
  codec           TEXT NOT NULL DEFAULT 'h264',
  resolution      TEXT,   -- e.g. '1920x1080'
  bitrate         INT,    -- kbps
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'active' | 'done' | 'error'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);
