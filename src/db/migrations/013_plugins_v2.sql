-- Extend the plugins table with richer metadata (Jellyfin-inspired manifest fields).
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS category           TEXT,
  ADD COLUMN IF NOT EXISTS overview           TEXT,
  ADD COLUMN IF NOT EXISTS homepage           TEXT,
  ADD COLUMN IF NOT EXISTS min_server_version TEXT,
  ADD COLUMN IF NOT EXISTS permissions        TEXT[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS data_path          TEXT,
  ADD COLUMN IF NOT EXISTS install_source     TEXT     DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS install_url        TEXT,
  ADD COLUMN IF NOT EXISTS settings_schema    JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS has_tasks          BOOLEAN  DEFAULT false;

-- Catalog sources — remote repositories of installable plugins.
-- Analogous to Jellyfin's repository system (Settings → Plugins → Repositories).
CREATE TABLE IF NOT EXISTS plugin_catalog_sources (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  url        TEXT        NOT NULL UNIQUE,
  is_enabled BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
