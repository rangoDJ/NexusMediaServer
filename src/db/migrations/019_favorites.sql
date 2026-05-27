-- Per-user favorites list. Separate from watch_progress so items can be
-- starred before ever being watched.
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_item_id UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, media_item_id)
);
CREATE INDEX IF NOT EXISTS user_favorites_user_idx ON user_favorites(user_id);
