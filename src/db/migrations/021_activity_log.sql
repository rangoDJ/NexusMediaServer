-- Server activity/audit trail — logins, scans, plugin changes, user changes,
-- failed scheduled tasks. Jellyfin-style: a small, high-signal event feed,
-- not a mirror of the application log.
CREATE TABLE activity_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warning' | 'error'
  message    TEXT NOT NULL,
  -- SET NULL, not CASCADE — deleting a user shouldn't erase the historical
  -- record that they did something.
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_log_created_at ON activity_log (created_at DESC);
