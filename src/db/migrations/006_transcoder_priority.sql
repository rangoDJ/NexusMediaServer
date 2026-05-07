ALTER TABLE transcoder_nodes
  ADD COLUMN priority    INT     NOT NULL DEFAULT 0,
  ADD COLUMN hw_accel    TEXT    NOT NULL DEFAULT 'cpu',  -- 'cpu' | 'nvenc' | 'vaapi' | 'qsv'
  ADD COLUMN is_builtin  BOOLEAN NOT NULL DEFAULT false;

-- New settings for default priorities (shown in Settings → Transcoding)
INSERT INTO settings(key, value, category, label, description) VALUES
  ('transcoding.cpu_priority',
   '1',
   'transcoding',
   'CPU transcoder priority',
   'Default priority for the built-in CPU transcoder. Lower numbers lose to higher ones.'),

  ('transcoding.nvenc_priority',
   '10',
   'transcoding',
   'NVIDIA NVENC priority',
   'Default priority assigned when an NVENC transcoder self-registers.'),

  ('transcoding.vaapi_priority',
   '8',
   'transcoding',
   'Intel VAAPI priority',
   'Default priority assigned when a VAAPI transcoder self-registers.'),

  ('transcoding.qsv_priority',
   '8',
   'transcoding',
   'Intel QuickSync priority',
   'Default priority assigned when a QSV transcoder self-registers.');
