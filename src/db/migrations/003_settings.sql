CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed defaults
INSERT INTO settings(key, value, category, label, description) VALUES
  -- General
  ('server.name',               '"Nexus Media Server"',  'general',     'Server name',                'Displayed in the browser tab and UI header'),
  ('server.base_url',           '""',                    'general',     'Base URL',                   'Public-facing URL (e.g. https://media.example.com). Used for link generation.'),
  ('auth.allow_registration',   'true',                  'general',     'Open registration',          'Allow anyone to create an account. Disable for invite-only.'),
  ('auth.default_role',         '"viewer"',              'general',     'Default new user role',      'Role assigned to newly registered users.'),
  ('auth.session_days',         '30',                    'general',     'Session length (days)',      'How long a login token remains valid.'),

  -- Metadata
  ('tmdb.enabled',              'true',                  'metadata',    'Fetch TMDB metadata',        'Automatically fetch posters, plot, and ratings from TMDB when scanning.'),
  ('tmdb.api_key',              '""',                    'metadata',    'TMDB API key',               'Get a free key at https://www.themoviedb.org/settings/api'),
  ('tmdb.language',             '"en"',                  'metadata',    'Metadata language',          'ISO 639-1 language code for titles and descriptions (e.g. en, de, fr).'),
  ('metadata.nfo_priority',     'true',                  'metadata',    'NFO takes priority',         'When an NFO file exists, its values override TMDB data.'),

  -- Library
  ('library.auto_scan',         'true',                  'library',     'Auto-scan on startup',       'Re-scan all libraries when the server starts.'),
  ('library.scan_interval_hrs', '24',                    'library',     'Scan interval (hours)',      'How often libraries are automatically re-scanned. 0 to disable.'),

  -- Transcoding
  ('transcoding.default_codec',      '"h264"',           'transcoding', 'Default codec',              'h264 (broad compatibility) or h265 (smaller files, higher CPU).'),
  ('transcoding.default_resolution', '"1080p"',          'transcoding', 'Default resolution',         '4k, 1080p, 720p, 480p, or 360p.'),
  ('transcoding.default_bitrate',    'null',             'transcoding', 'Default bitrate (kbps)',     'Leave empty to use resolution preset. Override with a fixed kbps value.'),
  ('transcoding.hardware_accel',     '"none"',           'transcoding', 'Hardware acceleration',      'none, nvenc (NVIDIA), vaapi (Intel/AMD), or qsv (Intel QuickSync).'),
  ('transcoding.max_concurrent',     '4',                'transcoding', 'Max sessions per node',      'Transcoder nodes will be skipped once they reach this session count.'),
  ('transcoding.segment_secs',       '4',                'transcoding', 'HLS segment duration (s)',   'Smaller = faster seek. Larger = fewer requests. 2–6 is typical.'),
  ('transcoding.session_ttl_hrs',    '4',                'transcoding', 'Session TTL (hours)',         'Inactive transcode sessions are cleaned up after this many hours.');
