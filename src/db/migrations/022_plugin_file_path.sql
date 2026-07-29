-- Persist the plugin's on-disk entry point so a disabled (and therefore
-- unloaded, out-of-registry) plugin can be re-imported when it's re-enabled,
-- without having to rescan PLUGINS_PATH.
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS file_path TEXT;
