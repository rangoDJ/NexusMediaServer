CREATE TABLE plugins (
  id          TEXT PRIMARY KEY,   -- matches manifest.id, derived from folder/filename
  name        TEXT NOT NULL,
  version     TEXT,
  description TEXT,
  author      TEXT,
  is_enabled  BOOLEAN NOT NULL DEFAULT true,
  settings    JSONB NOT NULL DEFAULT '{}',
  error       TEXT,               -- last load error, if any
  loaded_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
