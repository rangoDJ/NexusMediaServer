-- Per-user library access control (opt-in allowlist).
--
-- Semantics: a user with ZERO rows here can see every library (today's
-- behavior — nothing breaks for existing installs that never configure
-- this). Once an admin adds at least one row for a user, that user is
-- restricted to exactly the libraries listed. Admins always see everything
-- regardless of this table (enforced in code, not here).
CREATE TABLE IF NOT EXISTS user_library_access (
  user_id    UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, library_id)
);

CREATE INDEX IF NOT EXISTS idx_user_library_access_user ON user_library_access(user_id);
